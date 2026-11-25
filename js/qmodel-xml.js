/*
 * qmodel-xml.js - QModel file format 1 (XML form): reader, canonical writer,
 * checker. Part of the AI Statechart demo (MIT License, see LICENSE).
 * Plain JavaScript, no dependencies; runs in Node and in the browser.
 * Format: Section 3 of the paper, https://doi.org/10.5281/zenodo.24519410
 *
 *   node qmodel-xml.js check  <file>...   problems, exit code 1 on errors
 *   node qmodel-xml.js format <file>      canonical form to stdout
 *   node qmodel-xml.js format --write <file>
 *   node qmodel-xml.js tree   <file>      rows of the linear statechart view
 *
 * The tree is generic: { tag, attrs: [[name, value]...], children: [],
 * lines: string[] | null (block content), line: number }.
 * Source positions (1-based lines) recorded by read(): line (start tag),
 * tagEndLine (last line of the start tag), endLine (end tag, or the
 * self-closing tag), cdataLine / cdataEndLine (blocks).
 */
'use strict';
(function () {   // own scope, so the file can share a browser page with ops.js

// ---------------------------------------------------------------- schema --

// user-material blocks: content is one CDATA section, verbatim
const BLOCKS = new Set(['doc', 'entry', 'exit', 'guard', 'action', 'code', 'text']);

// elements at column 0; everything else is indented 4 (never cumulative)
const ZERO = new Set(['model', 'package', 'class', 'operation', 'statechart',
                      'state', 'file']);

// one blank line before each of these start tags (and before </model>)
const BLANK_BEFORE = new Set(['package', 'class', 'attribute', 'operation',
                              'statechart', 'state', 'file']);

// canonical attribute order per element
const ATTRS = {
    model:      ['format', 'framework'],
    package:    ['name'],
    class:      ['name', 'super'],
    attribute:  ['name', 'type', 'visibility', 'modifiers'],
    operation:  ['name', 'type', 'visibility', 'modifiers'],
    param:      ['name', 'type'],
    trace:      ['ref'],
    statechart: [],
    state:      ['name', 'super'],
    initial:    ['target'],
    history:    ['type', 'target'],
    tran:       ['trig', 'target', 'via'],
    choice:     ['target', 'via'],
    else:       ['target', 'via'],
    file:       ['path'],
};
for (const b of BLOCKS) ATTRS[b] = [];

// canonical child order per parent; children of equal rank keep file order
// (choice and else share a rank: evaluation order is meaning)
const ORDER = {
    model:      ['doc', 'package', 'file'],
    package:    ['doc', 'trace', 'attribute', 'operation', ['class', 'package']],
    class:      ['doc', 'trace', 'attribute', 'operation', 'statechart'],
    attribute:  ['doc', 'trace', 'code'],   // code: enum body or initializer, as in QM
    operation:  ['doc', 'trace', 'param', 'code'],
    statechart: ['doc', 'initial', 'state'],
    state:      ['doc', 'trace', 'entry', 'exit', 'initial', 'history', 'tran'],
    initial:    ['action'],
    history:    ['action'],
    tran:       ['doc', 'trace', 'action', ['choice', 'else']],
    choice:     ['guard', 'action', ['choice', 'else']],
    else:       ['action', ['choice', 'else']],
    file:       ['doc', 'text'],
    param: [], trace: [],
};
function rank(parent, tag) {
    const o = ORDER[parent] || [];
    for (let i = 0; i < o.length; ++i) {
        if (o[i] === tag || (Array.isArray(o[i]) && o[i].includes(tag))) return i;
    }
    return -1;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const FORMAT = 'qmodel-1';

// ---------------------------------------------------------------- reader --

class ParseError extends Error {
    constructor(msg, line) { super(msg); this.line = line; }
}

function decodeEntities(s, line) {
    return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
        switch (e) {
            case 'amp': return '&'; case 'lt': return '<'; case 'gt': return '>';
            case 'quot': return '"'; case 'apos': return "'";
        }
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16)
                                                 : parseInt(e.slice(1), 10));
    }).replace(/&/g, () => { throw new ParseError('bare "&" (write &amp;)', line); });
}

// Raw block text -> lines. Canonical raw text is "\n" + lines + "\n" + ws:
// the line break after <![CDATA[ and the whitespace-only last line
// (the indentation of ]]>) are not content.
function blockLines(raw) {
    let s = raw;
    if (s.startsWith('\n')) s = s.slice(1);
    const nl = s.lastIndexOf('\n');
    const last = s.slice(nl + 1);
    if (/^[ \t]*$/.test(last)) s = nl >= 0 ? s.slice(0, nl + 1) : '';
    if (s === '') return [];
    if (s.endsWith('\n')) s = s.slice(0, -1);
    return s.split('\n');
}

/** Parse text; returns { root, problems }. Throws only on fatal syntax. */
function read(text) {
    const src = text.replace(/\r\n?/g, '\n');
    const problems = [];
    let pos = 0, line = 1;
    const adv = (n) => {
        for (let i = 0; i < n; ++i) if (src.charCodeAt(pos + i) === 10) ++line;
        pos += n;
    };
    const warn = (msg, ln, sev = 'warning') => problems.push({ sev, line: ln, msg });

    if (src.startsWith('\uFEFF')) adv(1);
    if (src.startsWith('<?xml', pos)) {
        const e = src.indexOf('?>', pos);
        if (e < 0) throw new ParseError('unterminated XML declaration', line);
        adv(e + 2 - pos);
    } else {
        warn('missing XML declaration', 1);
    }

    const stack = [];
    let root = null;
    let blockRaw = null;            // accumulating content of a block element

    while (pos < src.length) {
        const lt = src.indexOf('<', pos);
        const textEnd = lt < 0 ? src.length : lt;
        if (textEnd > pos) {
            const t = src.slice(pos, textEnd);
            const top = stack[stack.length - 1];
            if (top && BLOCKS.has(top.tag)) {
                blockRaw.push(decodeEntities(t, line));
                if (t.trim() !== '') top.plainText = true;
            } else if (t.trim() !== '') {
                throw new ParseError('text outside a block element: "' +
                                     t.trim().slice(0, 30) + '"', line);
            }
            adv(textEnd - pos);
            if (lt < 0) break;
        }
        if (src.startsWith('<![CDATA[', pos)) {
            const top = stack[stack.length - 1];
            if (!top || !BLOCKS.has(top.tag)) {
                throw new ParseError('CDATA outside a block element', line);
            }
            const e = src.indexOf(']]>', pos + 9);
            if (e < 0) throw new ParseError('unterminated CDATA section', line);
            blockRaw.push(src.slice(pos + 9, e));
            top.cdataCount = (top.cdataCount || 0) + 1;
            top.cdataLine = line;               // line of <![CDATA[
            adv(e - pos);
            top.cdataEndLine = line;            // line of ]]>
            adv(3);
        } else if (src.startsWith('<!--', pos)) {
            const e = src.indexOf('-->', pos);
            if (e < 0) throw new ParseError('unterminated comment', line);
            warn('comments are not part of the format and are dropped by ' +
                 'the writer (use <doc>)', line, 'error');
            adv(e + 3 - pos);
        } else if (src.startsWith('<!', pos) || src.startsWith('<?', pos)) {
            throw new ParseError('DOCTYPE and processing instructions are not allowed', line);
        } else if (src.startsWith('</', pos)) {
            const m = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(src.slice(pos, pos + 200));
            if (!m) throw new ParseError('malformed end tag', line);
            const top = stack.pop();
            if (!top || top.tag !== m[1]) {
                throw new ParseError('</' + m[1] + '> does not match <' +
                                     (top ? top.tag : '(none)') + '>', line);
            }
            if (BLOCKS.has(top.tag)) {
                top.lines = blockLines(blockRaw.join(''));
                blockRaw = null;
            }
            top.endLine = line;                 // line of the end tag
            adv(m[0].length);
        } else {
            const startLine = line;
            const m = /^<([A-Za-z_][\w.-]*)/.exec(src.slice(pos, pos + 200));
            if (!m) throw new ParseError('malformed tag', line);
            adv(m[0].length);
            const node = { tag: m[1], attrs: [], children: [], lines: null, line: startLine };
            const seen = new Set();
            for (;;) {
                const ws = /^\s*/.exec(src.slice(pos))[0];
                adv(ws.length);
                if (src.startsWith('/>', pos)) { adv(2); node.selfClosed = true; break; }
                if (src.startsWith('>', pos)) { adv(1); break; }
                const a = /^([A-Za-z_][\w.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/
                              .exec(src.slice(pos));
                if (!a || ws.length === 0) throw new ParseError('malformed attribute in <' +
                                                                node.tag + '>', line);
                if (seen.has(a[1])) throw new ParseError('duplicate attribute ' + a[1], line);
                seen.add(a[1]);
                const v = a[3] !== undefined ? a[3] : a[4];
                node.attrs.push([a[1], decodeEntities(v, line)]);
                adv(a[0].length);
            }
            node.tagEndLine = line;             // last line of the start tag
            if (node.selfClosed) node.endLine = line;
            const parent = stack[stack.length - 1];
            if (parent) {
                if (BLOCKS.has(parent.tag)) {
                    throw new ParseError('element <' + node.tag + '> inside block <' +
                                         parent.tag + '>', startLine);
                }
                parent.children.push(node);
            } else if (root) {
                throw new ParseError('more than one root element', startLine);
            } else {
                root = node;
            }
            if (BLOCKS.has(node.tag)) {
                if (node.selfClosed) node.lines = [];
                else blockRaw = [];
            }
            if (!node.selfClosed) stack.push(node);
        }
    }
    if (stack.length) {
        throw new ParseError('<' + stack[stack.length - 1].tag + '> is not closed', line);
    }
    if (!root) throw new ParseError('no root element', line);
    return { root, problems };
}

// ---------------------------------------------------------------- writer --

const attr = (n, k) => { const a = n.attrs.find((x) => x[0] === k); return a ? a[1] : undefined; };
const kids = (n, tag) => n.children.filter((c) => c.tag === tag);

function escAttr(v) {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// trigger list: one or more signals, canonical "A, B, C" (QM's notation)
const CATCH_ALL = 'CATCH_ALL';
const trigList = (v) => v.split(',').map((x) => x.trim());
const canonValue = (tag, k, v) => (tag === 'tran' && k === 'trig' ? trigList(v).join(', ') : v);

function sortedAttrs(n) {
    const order = ATTRS[n.tag] || [];
    const known = order.map((k) => n.attrs.find((a) => a[0] === k)).filter(Boolean)
                       .map(([k, v]) => [k, canonValue(n.tag, k, v)]);
    const rest = n.attrs.filter((a) => !order.includes(a[0]));
    return known.concat(rest);
}

function sortedChildren(n) {
    return n.children
        .map((c, i) => ({ c, i, r: rank(n.tag, c.tag) }))
        .sort((x, y) => (x.r === y.r ? x.i - y.i
                         : (x.r < 0 ? 1e9 : x.r) - (y.r < 0 ? 1e9 : y.r)))
        .map((x) => x.c);
}

/** Canonical lines of one element (with its leading blank line, if any). */
function writeNode(n) {
    const out = [];
    const emit = (n) => {
        const ind = ZERO.has(n.tag) ? '' : '    ';
        if (BLANK_BEFORE.has(n.tag)) out.push('');
        const head = ind + '<' + n.tag +
            sortedAttrs(n).map(([k, v]) => ' ' + k + '="' + escAttr(v) + '"').join('');
        if (BLOCKS.has(n.tag)) {
            out.push(head + '><![CDATA[');
            for (const l of n.lines || []) out.push(l);
            out.push(ind + ']]></' + n.tag + '>');
        } else if (n.children.length === 0) {
            out.push(head + '/>');
        } else {
            out.push(head + '>');
            for (const c of sortedChildren(n)) emit(c);
            if (n.tag === 'model') out.push('');
            out.push(ind + '</' + n.tag + '>');
        }
    };
    emit(n);
    return out;
}

/** Canonical text of a tree. */
function write(root) {
    return [XML_DECL].concat(writeNode(root)).join('\n') + '\n';
}

// --------------------------------------------------------------- checker --

/** All problems in a file's text: [{ sev: 'error'|'warning', line, msg }]. */
function check(text) {
    let parsed;
    try {
        parsed = read(text);
    } catch (e) {
        if (e instanceof ParseError) return [{ sev: 'error', line: e.line, msg: e.message }];
        throw e;
    }
    const { root, problems } = parsed;
    const P = (sev, n, msg) => problems.push({ sev, line: n ? n.line : 0, msg });
    const E = (n, msg) => P('error', n, msg);
    const W = (n, msg) => P('warning', n, msg);

    // --- structure (the XSD says the same, with worse messages)
    if (root.tag !== 'model') E(root, 'root element must be <model>');
    if (attr(root, 'format') !== FORMAT) E(root, 'format must be "' + FORMAT + '"');
    if (!['qpc', 'qpcpp'].includes(attr(root, 'framework'))) {
        E(root, 'framework must be "qpc" or "qpcpp"');
    }
    const walk = (n, parent) => {
        if (parent && rank(parent.tag, n.tag) < 0) {
            E(n, '<' + n.tag + '> is not allowed in <' + parent.tag + '>');
        }
        for (const [k] of n.attrs) {
            if (ATTRS[n.tag] && !ATTRS[n.tag].includes(k)) {
                E(n, 'unknown attribute ' + k + ' on <' + n.tag + '>');
            }
        }
        if (BLOCKS.has(n.tag)) {
            if ((n.lines || []).some((l) => l.includes(']]>'))) {
                E(n, 'block content contains "]]>"; break it up, e.g. "] ]>"');
            }
            if (n.plainText) W(n, 'block content is not in a CDATA section');
            if (n.cdataCount > 1) W(n, 'block has more than one CDATA section');
        }
        const ch = n.children;
        const firstBranch = ch.findIndex((c) => c.tag === 'else');
        if (firstBranch >= 0 && firstBranch !== ch.length - 1) E(ch[firstBranch], '<else> must be last');
        if (kids(n, 'else').length > 1) E(kids(n, 'else')[1], 'more than one <else>');
        if (n.tag === 'choice' && kids(n, 'guard').length !== 1) E(n, '<choice> needs exactly one <guard>');
        for (const c of ch) walk(c, n);
    };
    walk(root, null);

    // --- names and references, per class
    const classes = [];
    const pkgWalk = (p) => {
        for (const c of p.children) {
            if (c.tag === 'class') classes.push(c);
            if (c.tag === 'package') pkgWalk(c);
        }
    };
    pkgWalk(root);
    const dupes = (nodes, what) => {
        const m = new Map();
        for (const n of nodes) {
            const k = attr(n, 'name');
            if (m.has(k)) E(n, 'duplicate ' + what + ' "' + k + '"');
            else m.set(k, n);
        }
        return m;
    };
    dupes(classes, 'class');
    for (const p of [root].concat(root.children.filter((c) => c.tag === 'package'))) {
        dupes(kids(p, 'package'), 'package');
    }
    for (const cls of classes) {
        dupes(kids(cls, 'attribute').concat(kids(cls, 'operation')), 'member');
        const machines = kids(cls, 'statechart');
        const allStates = machines.flatMap((m) => kids(m, 'state'));
        const byName = dupes(allStates, 'state');   // unique per class (QP function names)
        for (const m of machines) checkMachine(m, byName, E, W);
    }

    // --- canonical form
    if (!problems.some((p) => p.sev === 'error')) {
        const canon = write(root).split('\n');
        const have = text.replace(/\r\n?/g, '\n').split('\n');
        for (let i = 0; i < Math.max(canon.length, have.length); ++i) {
            if (canon[i] !== have[i]) {
                problems.push({ sev: 'warning', line: i + 1,
                    msg: 'not in canonical form here; expected: ' +
                         JSON.stringify(canon[i] === undefined ? '(end of file)' : canon[i]) });
                break;
            }
        }
    }
    return problems.sort((a, b) => a.line - b.line);
}

function checkMachine(m, byName, E, W) {
    const states = kids(m, 'state');
    const local = new Map(states.map((s) => [attr(s, 'name'), s]));
    const sup = (s) => local.get(attr(s, 'super'));

    // hierarchy
    for (const s of states) {
        const p = attr(s, 'super');
        if (p === undefined) continue;
        if (!local.has(p)) {
            E(s, byName.has(p) ? 'super "' + p + '" is in another state machine'
                               : 'unknown super state "' + p + '"');
            continue;
        }
        const seen = new Set([s]);
        for (let a = sup(s); a; a = sup(a)) {
            if (seen.has(a)) { E(s, 'super-state cycle through "' + attr(s, 'name') + '"'); break; }
            seen.add(a);
        }
    }
    const isAncestor = (a, s) => {
        for (let x = sup(s), n = 0; x && n < 1000; x = sup(x), ++n) if (x === a) return true;
        return false;
    };
    const children = (s) => states.filter((c) => attr(c, 'super') === attr(s, 'name'));

    // targets
    const targeted = new Set();
    const checkTarget = (n, owner) => {
        const t = attr(n, 'target'), via = attr(n, 'via');
        if (via !== undefined && via !== 'history') E(n, 'via must be "history"');
        if (via !== undefined && t === undefined) E(n, 'via="' + via + '" without a target');
        if (t === undefined) return;
        const ts = local.get(t);
        if (!ts) {
            E(n, byName.has(t) ? 'target "' + t + '" is in another state machine'
                               : 'unknown target state "' + t + '"');
            return;
        }
        targeted.add(ts);
        if (via === 'history' && kids(ts, 'history').length === 0) {
            E(n, 'target "' + t + '" has no <history>');
        }
        if (owner && n.tag === 'initial' && !isAncestor(owner, ts)) {
            E(n, 'initial target "' + t + '" is not a substate of "' + attr(owner, 'name') + '"');
        }
        if (owner && n.tag === 'history' && !isAncestor(owner, ts)) {
            E(n, 'history target "' + t + '" is not a substate of "' + attr(owner, 'name') + '"');
        }
    };
    const branches = (n) => {
        for (const b of n.children) {
            if (b.tag !== 'choice' && b.tag !== 'else') continue;
            const nested = b.children.some((c) => c.tag === 'choice' || c.tag === 'else');
            if (nested && attr(b, 'target')) {
                E(b, 'a branch leads either to a target or to a nested choice, not both');
            }
            checkTarget(b, null);
            branches(b);
        }
    };
    for (const i of kids(m, 'initial')) checkTarget(i, null);
    if (kids(m, 'initial').length !== 1) E(m, '<' + m.tag + '> needs exactly one <initial>');

    for (const s of states) {
        for (const i of kids(s, 'initial')) checkTarget(i, s);
        for (const h of kids(s, 'history')) {
            if (children(s).length === 0) E(h, 'history in a leaf state');
            checkTarget(h, s);
        }
        const trigs = new Map();
        for (const t of kids(s, 'tran')) {
            const hasBranches = t.children.some((c) => c.tag === 'choice' || c.tag === 'else');
            if (hasBranches && attr(t, 'target')) {
                E(t, 'a transition with choices has no target of its own');
            }
            if (hasBranches && kids(t, 'choice').length === 0) E(t, '<else> without <choice>');
            checkTarget(t, null);
            branches(t);
            // every signal at most once per state, also across trigger lists
            // (QM: guard alternatives go into choice segments of ONE tran)
            const list = trigList(attr(t, 'trig') || '');
            for (const sig of list) {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sig)) {
                    E(t, 'not a signal name: "' + sig + '"');
                } else if (trigs.has(sig)) {
                    E(t, 'trigger ' + sig + ' appears more than once in "' + attr(s, 'name') +
                         '" (use choices in one transition)');
                }
                trigs.set(sig, t);
            }
            if (list.includes(CATCH_ALL) && list.length > 1) {
                E(t, CATCH_ALL + ' cannot be combined with other triggers');
            }
            if (new Set(list).size !== list.length) E(t, 'duplicate signal in trigger list');
        }
    }

    // reachability: a state is entered if it or any substate is targeted
    for (const s of states) {
        const reached = (x) => targeted.has(x) || children(x).some(reached);
        if (!reached(s)) W(s, 'state "' + attr(s, 'name') + '" is never entered');
    }

    // tree order: each state follows its super state's subtree
    const pre = [];
    const visit = (s) => { pre.push(s); children(s).forEach(visit); };
    states.filter((s) => attr(s, 'super') === undefined || !local.has(attr(s, 'super')))
          .forEach(visit);
    for (let i = 0; i < Math.min(pre.length, states.length); ++i) {
        if (pre[i] !== states[i]) {
            W(states[i], 'states are not in tree order from here (expected "' +
                         attr(pre[i], 'name') + '")');
            break;
        }
    }
}

// ------------------------------------------------- linear view rows (tree) --

/** Rows of the linear statechart view, as indented text (layout step 1). */
function rows(root) {
    const out = [];
    const tgt = (n) => {
        if (!attr(n, 'target')) return ' [internal]';
        return ' -> ' + attr(n, 'target') + (attr(n, 'via') === 'history' ? ' (H)' : '');
    };
    const firstLine = (n, tag) => { const b = kids(n, tag)[0]; return b && b.lines[0] || ''; };
    const branchRows = (n, pad) => {
        for (const b of n.children) {
            if (b.tag === 'choice') {
                out.push(pad + '<> [' + firstLine(b, 'guard').trim() + ']' +
                         (b.children.some((c) => c.tag === 'choice' || c.tag === 'else') ? ''
                                                                                          : tgt(b)));
            } else if (b.tag === 'else') {
                out.push(pad + '<> [else]' +
                         (b.children.some((c) => c.tag === 'choice' || c.tag === 'else') ? ''
                                                                                          : tgt(b)));
            } else continue;
            branchRows(b, pad + '  ');
        }
    };
    const classes = [];
    const pk = (p) => p.children.forEach((c) => {
        if (c.tag === 'class') classes.push(c);
        if (c.tag === 'package') pk(c);
    });
    pk(root);
    for (const cls of classes) {
        for (const m of kids(cls, 'statechart')) {
            out.push(attr(cls, 'name'));
            for (const i of kids(m, 'initial')) out.push('  *' + tgt(i));
            const states = kids(m, 'state');
            const visit = (s, d) => {
                const pad = '  '.repeat(d);
                out.push(pad + '== ' + attr(s, 'name'));
                if (kids(s, 'entry').length) out.push(pad + '  entry');
                if (kids(s, 'exit').length) out.push(pad + '  exit');
                for (const i of kids(s, 'initial')) out.push(pad + '  *' + tgt(i));
                for (const h of kids(s, 'history')) {
                    out.push(pad + '  ' + (attr(h, 'type') === 'deep' ? 'H*' : 'H') + tgt(h));
                }
                for (const t of kids(s, 'tran')) {
                    const br = t.children.some((c) => c.tag === 'choice' || c.tag === 'else');
                    out.push(pad + '  ' + attr(t, 'trig') + (br ? '' : tgt(t)));
                    branchRows(t, pad + '    ');
                }
                states.filter((c) => attr(c, 'super') === attr(s, 'name'))
                      .forEach((c) => visit(c, d + 1));
            };
            states.filter((s) => attr(s, 'super') === undefined).forEach((s) => visit(s, 1));
        }
    }
    return out.join('\n') + '\n';
}

// ------------------------------------------------------------------- CLI --

const api = { read, write, check, rows, ParseError, BLOCKS, ZERO,
              attr, kids, sortedAttrs, sortedChildren, escAttr, rank, writeNode };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.qmodelXml = api;

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const fs = require('fs');
    const [cmd, ...args] = process.argv.slice(2);
    const writeBack = args[0] === '--write';
    const files = writeBack ? args.slice(1) : args;
    let rc = 0;
    if (!cmd || !files.length) {
        console.error('usage: qmodel-xml.js check|format [--write]|tree <file>...');
        process.exit(2);
    }
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        if (cmd === 'check') {
            const ps = check(text);
            for (const p of ps) console.log(f + ':' + p.line + ': ' + p.sev + ': ' + p.msg);
            if (!ps.length) console.log(f + ': OK');
            if (ps.some((p) => p.sev === 'error')) rc = 1;
        } else if (cmd === 'format') {
            const out = write(read(text).root);
            if (writeBack) fs.writeFileSync(f, out); else process.stdout.write(out);
        } else if (cmd === 'tree') {
            process.stdout.write(rows(read(text).root));
        } else {
            console.error('unknown command ' + cmd); process.exit(2);
        }
    }
    process.exit(rc);
}
})();
