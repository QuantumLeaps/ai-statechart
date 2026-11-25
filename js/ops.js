/*
 * ops.js - editing operations as minimal line edits on the model text.
 * Part of the AI Statechart demo (MIT License, see LICENSE).
 * Plain JavaScript, no dependencies.
 *
 * Every operation takes the CURRENT text (never a cached model), parses it,
 * and returns an array of line edits. In VS Code the array becomes ONE
 * WorkspaceEdit, so VS Code's single undo stack gets one entry per operation.
 *
 *   edit = { line, del, ins }   at 1-based `line`, delete `del` lines,
 *                               insert the lines `ins` (edits never overlap)
 *
 * Operations rewrite only the elements they change, in canonical form;
 * everything else, including hand-formatted text, is left byte for byte.
 */
'use strict';
(function () {   // own scope, so the file can share a browser page with qmodel-xml.js
const q = (typeof require !== 'undefined') ? require('./qmodel-xml.js') : window.qmodelXml;
const { read, attr, kids, writeNode, sortedAttrs, escAttr, rank, ZERO } = q;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRANCH = new Set(['choice', 'else']);

// ------------------------------------------------------------- helpers --

function locate(text, cls) {
    const { root } = read(text);              // throws ParseError on broken XML
    const classes = [];
    const walk = (p) => p.children.forEach((c) => {
        if (c.tag === 'class') classes.push(c);
        if (c.tag === 'package') walk(c);
    });
    walk(root);
    const c = cls ? classes.find((x) => attr(x, 'name') === cls) : classes[0];
    if (!c) throw new Error('no class ' + (cls || ''));
    const machines = kids(c, 'statechart');
    const states = machines.flatMap((m) => kids(m, 'state'));
    const state = (name) => {
        const s = states.find((x) => attr(x, 'name') === name);
        if (!s) throw new Error('no state ' + name);
        return s;
    };
    return { root, cls: c, machines, states, state };
}

/** Edit that replaces an element's start tag with `attrs` (canonical). */
function retag(n, attrs, selfClosed = n.selfClosed) {
    const ind = ZERO.has(n.tag) ? '' : '    ';
    const m = { tag: n.tag, attrs };
    const head = ind + '<' + n.tag +
        sortedAttrs(m).map(([k, v]) => ' ' + k + '="' + escAttr(v) + '"').join('') +
        (selfClosed ? '/>' : '>');
    return { line: n.line, del: n.tagEndLine - n.line + 1, ins: [head] };
}
const setAttr = (attrs, k, v) => {
    const out = attrs.filter((a) => a[0] !== k);
    if (v !== undefined) out.push([k, v]);
    return out;
};

// all elements that carry a target, in one class
function targetCarriers(L) {
    const out = [];
    const walk = (n) => {
        for (const c of n.children) {
            if (['initial', 'history', 'tran'].includes(c.tag) || BRANCH.has(c.tag)) {
                out.push(c);
            }
            walk(c);
        }
    };
    L.machines.forEach(walk);
    return out;
}

// last source line of an element, including its blank line before
const firstLine = (n, lines) => (n.line > 1 && lines[n.line - 2] === '' &&
                                 ['state', 'attribute', 'operation'].includes(n.tag)
                                 ? n.line - 1 : n.line);

// ---------------------------------------------------------- operations --

/** F2 on a state: rename it and every reference to it. */
function renameState(text, cls, oldName, newName) {
    const L = locate(text, cls);
    if (!NAME.test(newName)) throw new Error('not a name: ' + newName);
    if (L.states.some((s) => attr(s, 'name') === newName)) throw new Error('exists: ' + newName);
    const edits = [];
    const s = L.state(oldName);
    edits.push(retag(s, setAttr(s.attrs, 'name', newName)));
    for (const c of L.states) {
        if (attr(c, 'super') === oldName) edits.push(retag(c, setAttr(c.attrs, 'super', newName)));
    }
    for (const t of targetCarriers(L)) {
        if (attr(t, 'target') === oldName) edits.push(retag(t, setAttr(t.attrs, 'target', newName)));
    }
    return edits;
}

function findTran(L, stateName, trig, nth = 0) {
    const t = kids(L.state(stateName), 'tran').filter((x) => attr(x, 'trig') === trig)[nth];
    if (!t) throw new Error('no tran ' + trig + ' in ' + stateName);
    return t;
}

/** Drag an arrowhead onto another state line. */
function setTarget(text, cls, stateName, trig, target) {
    const L = locate(text, cls);
    L.state(target);
    const t = findTran(L, stateName, trig);
    if (t.children.some((c) => BRANCH.has(c.tag))) throw new Error('tran has choices');
    return [retag(t, setAttr(setAttr(t.attrs, 'target', target), 'via', undefined))];
}

/** `t` on a state row: new transition, after the state's last transition. */
function addTran(text, cls, stateName, trig, target) {
    const L = locate(text, cls);
    const s = L.state(stateName);
    if (target !== undefined) L.state(target);
    const t = { tag: 'tran', attrs: [['trig', trig]].concat(target ? [['target', target]] : []),
                children: [], lines: null };
    const line = writeNode(t);
    if (s.selfClosed) {                      // <state .../>  ->  <state ...> ... </state>
        const e = retag(s, s.attrs, false);
        e.ins.push(...line, '</state>');
        return [e];
    }
    const r = rank('state', 'tran');
    const before = s.children.filter((c) => rank('state', c.tag) <= r);
    const after = before.length ? before[before.length - 1].endLine : s.tagEndLine;
    return [{ line: after + 1, del: 0, ins: line }];
}

/** Delete a transition (with its actions and choices). */
function deleteTran(text, cls, stateName, trig, nth = 0) {
    const L = locate(text, cls);
    const s = L.state(stateName);
    const t = findTran(L, stateName, trig, nth);
    if (s.children.length === 1) {           // state becomes empty: self-closing
        const e = retag(s, s.attrs, true);
        return [{ line: s.line, del: s.endLine - s.line + 1, ins: e.ins }];
    }
    return [{ line: t.line, del: t.endLine - t.line + 1, ins: [] }];
}

// Edits that delete the children `gone` of `parent`; when nothing would be
// left, the parent becomes a self-closing element instead.
function deleteChildren(parent, gone) {
    if (gone.length && parent.children.every((c) => gone.includes(c))) {
        const e = retag(parent, parent.attrs, true);
        return [{ line: parent.line, del: parent.endLine - parent.line + 1, ins: e.ins }];
    }
    return gone.map((c) => ({ line: c.line, del: c.endLine - c.line + 1, ins: [] }));
}

/** Delete the entry or exit action (kind) of a state. */
function deleteBlock(text, cls, stateName, kind) {
    const L = locate(text, cls);
    const s = L.state(stateName);
    const b = kids(s, kind)[0];
    if (!b) throw new Error(stateName + ' has no ' + kind + ' action');
    return deleteChildren(s, [b]);
}

/** Move the nth transition of a state up (-1) or down (+1) among its transitions. */
function moveTran(text, cls, stateName, nth, dir) {
    const L = locate(text, cls);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const ts = kids(L.state(stateName), 'tran');
    const i = nth, j = i + dir;
    if (!ts[i]) throw new Error('no transition ' + nth + ' in ' + stateName);
    if (j < 0 || j >= ts.length) throw new Error('no transition to swap with');
    const [a, b] = dir < 0 ? [ts[j], ts[i]] : [ts[i], ts[j]];
    const A = lines.slice(a.line - 1, a.endLine);
    const gap = lines.slice(a.endLine, b.line - 1);
    const B = lines.slice(b.line - 1, b.endLine);
    return [{ line: a.line, del: b.endLine - a.line + 1, ins: B.concat(gap, A) }];
}

// the states of the machine that holds state s, with helpers for the tree
function stateTree(L, s) {
    const machine = L.machines.find((m) => kids(m, 'state').includes(s));
    const states = kids(machine, 'state');
    const sup = (x) => states.find((y) => attr(y, 'name') === attr(x, 'super'));
    const inSubtree = (x, root) => {
        for (let a = x, n = 0; a && n <= states.length; a = sup(a), ++n) if (a === root) return true;
        return false;
    };
    const subtree = (root) => states.filter((x) => inSubtree(x, root));
    return { machine, states, sup, inSubtree, subtree };
}
// first and last line of a subtree (with the leading blank line); it must be contiguous
function subtreeBlock(sub, lines, name) {
    const ok = sub.every((x, i) => i === 0 || firstLine(x, lines) === sub[i - 1].endLine + 1);
    if (!ok) throw new Error('the substates of ' + name + ' are not together in the file; restore tree order first');
    return { start: firstLine(sub[0], lines), end: sub[sub.length - 1].endLine };
}

/**
 * Move a state (with its substates) up (-1) or down (+1) among its siblings,
 * i.e. the states with the same superstate. Only the order of the lines changes.
 */
function moveState(text, cls, stateName, dir) {
    const L = locate(text, cls);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const s = L.state(stateName);
    const T = stateTree(L, s);
    const sib = T.states.filter((x) => attr(x, 'super') === attr(s, 'super'));
    const i = sib.indexOf(s), j = i + dir;
    if (j < 0 || j >= sib.length) throw new Error(stateName + ' has no ' + (dir < 0 ? 'previous' : 'next') + ' sibling');
    const [a, b] = dir < 0 ? [sib[j], s] : [s, sib[j]];
    const A = subtreeBlock(T.subtree(a), lines, attr(a, 'name'));
    const B = subtreeBlock(T.subtree(b), lines, attr(b, 'name'));
    if (B.start !== A.end + 1) throw new Error('the states are not in tree order in the file');
    const la = lines.slice(A.start - 1, A.end), lb = lines.slice(B.start - 1, B.end);
    // the blank line stays at the top of the pair, whichever block had it
    const blankA = la[0] === '', blankB = lb[0] === '';
    if (blankA !== blankB) {
        if (blankA) { la.shift(); lb.unshift(''); } else { lb.shift(); la.unshift(''); }
    }
    return [{ line: A.start, del: B.end - A.start + 1, ins: lb.concat(la) }];
}

/**
 * Delete a state with all its substates. Transitions and choice segments
 * elsewhere that went into the deleted states become internal (their ends
 * dangle). An initial transition of a superstate that went there is deleted,
 * and with it the superstate's history (whose default target it gave);
 * transitions via that history become plain. All of it is one edit list.
 */
function deleteState(text, cls, stateName) {
    const L = locate(text, cls);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const s = L.state(stateName);
    const T = stateTree(L, s);
    const sub = T.subtree(s);
    const names = new Set(sub.map((x) => attr(x, 'name')));
    const blk = subtreeBlock(sub, lines, stateName);
    const inside = (n) => n.line >= blk.start && n.line <= blk.end;
    const all = targetCarriers({ machines: [T.machine] });
    const parent = withParents(T.machine);
    const gone = new Map();               // state outside -> its children to delete
    const drop = (p, c) => { if (!gone.has(p)) gone.set(p, []); if (!gone.get(p).includes(c)) gone.get(p).push(c); };
    const unvia = new Set();              // states whose history goes away
    for (const c of all) {
        if (inside(c) || !names.has(attr(c, 'target'))) continue;
        const p = parent.get(c);
        if (c.tag === 'initial' && p.tag === 'statechart') {
            throw new Error('the initial transition of the state machine goes to ' + attr(c, 'target') +
                            '; retarget it first');
        }
        if (c.tag === 'initial' || c.tag === 'history') {
            drop(p, c);
            const h = kids(p, 'history')[0];
            if (h) { drop(p, h); unvia.add(attr(p, 'name')); }
        }
    }
    const edits = [{ line: blk.start, del: blk.end - blk.start + 1, ins: [] }];
    for (const [p, cs] of gone) edits.push(...deleteChildren(p, cs));
    for (const c of all) {
        if (inside(c) || c.tag === 'initial' || c.tag === 'history') continue;
        const t = attr(c, 'target');
        if (names.has(t)) {
            edits.push(retag(c, setAttr(setAttr(c.attrs, 'target', undefined), 'via', undefined)));
        } else if (unvia.has(t) && attr(c, 'via') === 'history') {
            edits.push(retag(c, setAttr(c.attrs, 'via', undefined)));
        }
    }
    return edits;
}

/** Double-click a row, edit the code in a tab: replace one block's content. */
function setBlock(text, cls, stateName, kind, contentLines) {
    const L = locate(text, cls);
    const b = kids(L.state(stateName), kind)[0];
    if (!b) throw new Error('no ' + kind + ' in ' + stateName);
    if (contentLines.some((l) => l.includes(']]>'))) throw new Error('"]]>" in code');
    if (b.cdataLine === undefined || b.cdataLine === b.cdataEndLine) {
        throw new Error('block not in canonical layout; format it first');
    }
    return [{ line: b.cdataLine + 1, del: b.cdataEndLine - b.cdataLine - 1, ins: contentLines }];
}

/**
 * Reparent a state with its subtree; it becomes the LAST child of newSuper
 * (undefined: last top-level state). Keeps the file in tree order: if the
 * subtree is not already in place, its lines move.
 * Tab on a state = reparent to its previous sibling: always one line.
 */
function reparent(text, cls, stateName, newSuper) {
    const L = locate(text, cls);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const s = L.state(stateName);
    const machine = L.machines.find((m) => kids(m, 'state').includes(s));
    const states = kids(machine, 'state');
    const sup = (x) => states.find((y) => attr(y, 'name') === attr(x, 'super'));
    const inSubtree = (x, root) => { for (let a = x; a; a = sup(a)) if (a === root) return true; return false; };
    if (newSuper !== undefined) {
        const p = L.state(newSuper);
        if (!states.includes(p)) throw new Error('other state machine');
        if (inSubtree(p, s)) throw new Error('cycle: ' + newSuper + ' is inside ' + stateName);
    }
    const moved = states.filter((x) => inSubtree(x, s));
    const rest = states.filter((x) => !moved.includes(x));
    // destination: after the last state of newSuper's subtree (or last state)
    const scope = newSuper === undefined ? rest
        : rest.filter((x) => inSubtree(x, L.state(newSuper)));
    const destEnd = scope.length ? scope[scope.length - 1].endLine
                                 : kids(machine, 'initial')[0].endLine;
    const head = retag(s, setAttr(s.attrs, 'super', newSuper));
    const blockStart = firstLine(s, lines);
    const blockEnd = moved[moved.length - 1].endLine;
    const contiguous = moved.every((x, i) => i === 0 || firstLine(x, lines) === moved[i - 1].endLine + 1);
    if (!contiguous) throw new Error('subtree of ' + stateName + ' is not contiguous; ' +
                                     'restore tree order first');
    // already in place: the block directly follows the destination
    if (blockStart === destEnd + 1) return [head];
    const block = lines.slice(blockStart - 1, blockEnd);
    block[s.line - blockStart] = head.ins[0];
    return [{ line: blockStart, del: blockEnd - blockStart + 1, ins: [] },
            { line: destEnd + 1, del: 0, ins: block }];
}

/**
 * Shift+Tab on a state the state (with its
 * subtree) becomes a sibling of its superstate, placed right after the
 * superstate's subtree. Its former later siblings stay where they are.
 */
function outdent(text, cls, stateName) {
    const L = locate(text, cls);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const s = L.state(stateName);
    const p = L.states.find((x) => attr(x, 'name') === attr(s, 'super'));
    if (!p) throw new Error(stateName + ' is already a top-level state');
    const machine = L.machines.find((m) => kids(m, 'state').includes(s));
    const states = kids(machine, 'state');
    const sup = (x) => states.find((y) => attr(y, 'name') === attr(x, 'super'));
    const inSubtree = (x, root) => { for (let a = x; a; a = sup(a)) if (a === root) return true; return false; };
    const moved = states.filter((x) => inSubtree(x, s));
    const rest = states.filter((x) => !moved.includes(x) && inSubtree(x, p));
    const destEnd = rest[rest.length - 1].endLine;      // end of p's remaining subtree
    const head = retag(s, setAttr(s.attrs, 'super', attr(p, 'super')));
    const blockStart = firstLine(s, lines);
    const blockEnd = moved[moved.length - 1].endLine;
    if (blockStart === destEnd + 1 || destEnd < blockStart) return [head];  // last child: 1 line
    const block = lines.slice(blockStart - 1, blockEnd);
    block[s.line - blockStart] = head.ins[0];
    return [{ line: blockStart, del: blockEnd - blockStart + 1, ins: [] },
            { line: destEnd + 1, del: 0, ins: block }];
}

// --------------------------------------------- applying (what VS Code does) --

/** Apply edits (non-overlapping) to text; returns { text, inverse }. */
function apply(text, edits) {
    const lines = text.split('\n');
    const asc = edits.slice().sort((a, b) => a.line - b.line || a.del - b.del);
    for (let i = 1; i < asc.length; ++i) {
        if (asc[i].line < asc[i - 1].line + asc[i - 1].del) throw new Error('overlapping edits');
    }
    const inverse = [];
    let off = 0;
    for (const e of asc) {
        inverse.push({ line: e.line + off, del: e.ins.length,
                       ins: lines.slice(e.line - 1, e.line - 1 + e.del) });
        off += e.ins.length - e.del;
    }
    for (const e of asc.slice().reverse()) lines.splice(e.line - 1, e.del, ...e.ins);
    return { text: lines.join('\n'), inverse };
}

/**
 * Set (or with value undefined, remove) one attribute of the element whose
 * start tag begins on `line`. Used for retargeting an arrow (target), renaming
 * a trigger (trig), renaming attributes and operations (name). The checker
 * reports any resulting problem (e.g. an unknown target).
 */
function setAttribute(text, line, name, value) {
    const { root } = read(text);
    let node = null;
    const walk = (n) => { if (n.line === line) node = n; n.children.forEach(walk); };
    walk(root);
    if (!node || node.lines) throw new Error('no element starts on line ' + line);
    // name may also be an object of several changes: { target: 's1', via: undefined }
    const changes = typeof name === 'object' ? name : { [name]: value };
    let attrs = node.attrs;
    for (const k of Object.keys(changes)) attrs = setAttr(attrs, k, changes[k]);
    return [retag(node, attrs)];
}

// ------------------------------------------------- choice segments (QM model) --
//
// QM's drawing order, which these operations follow:
//  1. a new transition is attached to its state and is internal (dangling end);
//  2. a choice segment attaches to a dangling end; its guard is typed for it;
//     its own end goes to a state (target) or stays dangling (internal);
//  3. more choice segments can attach to any dangling end (fan-out / nesting).
// A segment whose guard is "else" is an <else> element, always the last one.

function withParents(root) {
    const parent = new Map();
    const walk = (n) => n.children.forEach((c) => { parent.set(c, n); walk(c); });
    walk(root);
    return parent;
}
function nodeAt(root, line) {
    let node = null;
    const walk = (n) => { if (n.line === line && !n.lines) node = n; n.children.forEach(walk); };
    walk(root);
    return node;
}
const isBranch = (n) => n && (n.tag === 'choice' || n.tag === 'else');
const branchesOf = (n) => n.children.filter(isBranch);

/**
 * Attach a choice segment to the dangling end of the transition or segment
 * starting on `line`. guard: the guard text (may have several lines), or
 * null for an else segment.
 */
function addBranch(text, line, guard) {
    const { root } = read(text);
    const n = nodeAt(root, line);
    if (!n || !['tran', 'choice', 'else'].includes(n.tag)) {
        throw new Error('select a transition or a choice segment');
    }
    if (attr(n, 'target') !== undefined) {
        throw new Error('this end goes to a state; a choice segment attaches to a dangling end');
    }
    const br = branchesOf(n);
    const els = br.find((b) => b.tag === 'else');
    if (guard === null && els) throw new Error('this end already has an else segment');
    if (guard !== null && String(guard).trim() === '') throw new Error('a choice segment needs a guard');
    const seg = guard === null
        ? { tag: 'else', attrs: [], children: [], lines: null }
        : { tag: 'choice', attrs: [], lines: null,
            children: [{ tag: 'guard', attrs: [], children: [], lines: String(guard).split('\n') }] };
    const lines = writeNode(seg);
    if (n.selfClosed) {                       // <tran .../>  ->  <tran ...> ... </tran>
        const e = retag(n, n.attrs, false);
        e.ins.push(...lines, (ZERO.has(n.tag) ? '' : '    ') + '</' + n.tag + '>');
        return [e];
    }
    if (guard !== null && els) return [{ line: els.line, del: 0, ins: lines }];   // else stays last
    const last = n.children[n.children.length - 1];
    return [{ line: last.endLine + 1, del: 0, ins: lines }];
}

/** Delete the choice segment starting on `line` (with everything attached to it). */
function deleteBranch(text, line) {
    const { root } = read(text);
    const n = nodeAt(root, line);
    if (!isBranch(n)) throw new Error('select a choice segment');
    const p = withParents(root).get(n);
    if (p.children.length === 1) {            // the parent's end becomes dangling again
        const e = retag(p, p.attrs, true);
        return [{ line: p.line, del: p.endLine - p.line + 1, ins: e.ins }];
    }
    return [{ line: n.line, del: n.endLine - n.line + 1, ins: [] }];
}

/** Move the choice segment on `line` up (-1) or down (+1): evaluation order is meaning. */
function moveBranch(text, line, dir) {
    const { root } = read(text);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const n = nodeAt(root, line);
    if (!isBranch(n)) throw new Error('select a choice segment');
    const sib = branchesOf(withParents(root).get(n));
    const i = sib.indexOf(n), j = i + dir;
    if (j < 0 || j >= sib.length) throw new Error('no segment to swap with');
    const [a, b] = dir < 0 ? [sib[j], n] : [n, sib[j]];
    if (a.tag === 'choice' && b.tag === 'else' || a.tag === 'else') {
        throw new Error('the else segment always stays last');
    }
    const A = lines.slice(a.line - 1, a.endLine);
    const gap = lines.slice(a.endLine, b.line - 1);
    const B = lines.slice(b.line - 1, b.endLine);
    return [{ line: a.line, del: b.endLine - a.line + 1, ins: B.concat(gap, A) }];
}

/** Replace the guard of the choice segment starting on `line`. */
function setGuard(text, line, guard) {
    const { root } = read(text);
    const n = nodeAt(root, line);
    if (!n || n.tag !== 'choice') throw new Error('select a choice segment with a guard');
    if (String(guard).trim() === '') throw new Error('a guard cannot be empty');
    const g = kids(n, 'guard')[0];
    if (!g || g.cdataLine === undefined || g.cdataLine === g.cdataEndLine) {
        throw new Error('guard not in canonical layout; format it first');
    }
    const content = String(guard).split('\n');
    if (content.some((l) => l.includes(']]>'))) throw new Error('"]]>" in code');
    return [{ line: g.cdataLine + 1, del: g.cdataEndLine - g.cdataLine - 1, ins: content }];
}

// ------------------------------------------------------------- history --
//
// History: a composite state declares at most one
// <history> (shallow or deep); a transition enters it with via="history".
// In the diagram a transition is connected to the history by dropping its
// arrowhead (or dangling end) on the state's history ROW; dropping on the
// state LINE gives a plain transition (setTarget/setAttribute clear via).

/**
 * Shift+H on a composite state: give it a history of `type` ('shallow' or
 * 'deep'), change the type, or remove it (type undefined). A new history's
 * default target is the target of the state's initial transition. Removing
 * it also turns every via="history" into the state into a plain transition,
 * so the model stays valid; all of it is one edit list (one undo step).
 */
function setHistory(text, cls, stateName, type) {
    const L = locate(text, cls);
    const s = L.state(stateName);
    const h = kids(s, 'history')[0];
    if (type !== undefined && type !== 'shallow' && type !== 'deep') throw new Error('history type: ' + type);
    if (h && type !== undefined) return [retag(h, setAttr(h.attrs, 'type', type))];
    if (h) {
        const edits = [{ line: h.line, del: h.endLine - h.line + 1, ins: [] }];
        for (const c of targetCarriers(L)) {
            if (attr(c, 'target') === stateName && attr(c, 'via') === 'history') {
                edits.push(retag(c, setAttr(c.attrs, 'via', undefined)));
            }
        }
        return edits;
    }
    if (type === undefined) return [];
    if (!L.states.some((x) => attr(x, 'super') === stateName)) {
        throw new Error(stateName + ' has no substates: only a composite state has a history');
    }
    const ini = kids(s, 'initial')[0];
    const def = ini && attr(ini, 'target');
    if (!def) throw new Error(stateName + ' needs an initial transition first (it gives the default target)');
    const line = writeNode({ tag: 'history', attrs: [['type', type], ['target', def]], children: [], lines: null });
    const r = rank('state', 'history');
    const before = s.children.filter((c) => rank('state', c.tag) <= r);
    const after = before.length ? before[before.length - 1].endLine : s.tagEndLine;
    return [{ line: after + 1, del: 0, ins: line }];
}

/**
 * Connect the transition or choice segment starting on `line` to a target
 * state, plainly (via undefined) or through the target's history
 * (via 'history', drop on the history row or key h). The target must
 * declare a history for via="history".
 */
function connect(text, line, target, via) {
    const { root } = read(text);
    const n = nodeAt(root, line);
    if (!n || !['tran', 'choice', 'else', 'initial', 'history'].includes(n.tag)) {
        throw new Error('select a transition or a choice segment');
    }
    if (branchesOf(n).length) throw new Error('this transition has choice segments; connect a segment instead');
    if (via !== undefined) {
        if (!['tran', 'choice', 'else'].includes(n.tag)) throw new Error('only a transition or a choice segment can enter a history');
        const parent = withParents(root);
        let c = n;
        while (c && c.tag !== 'class') c = parent.get(c);
        const st = c && c.children.filter((m) => m.tag === 'statechart').flatMap((m) => kids(m, 'state'))
                               .find((s) => attr(s, 'name') === target);
        if (!st) throw new Error('no state ' + target);
        if (!kids(st, 'history').length) throw new Error(target + ' has no history (Shift+H on it adds one)');
    }
    return [retag(n, setAttr(setAttr(n.attrs, 'target', target), 'via', via))];
}

/** Number of lines an edit list changes (replaced + inserted + deleted). */
const linesTouched = (edits) => edits.reduce((n, e) => n + Math.max(e.del, e.ins.length), 0);

const api = { renameState, setTarget, addTran, deleteTran, setBlock, reparent, outdent,
              setAttribute, addBranch, deleteBranch, moveBranch, setGuard, setHistory, connect,
              deleteBlock, moveTran, moveState, deleteState,
              apply, linesTouched };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.qmodelOps = api;
})();
