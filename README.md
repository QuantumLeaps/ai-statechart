## Brought to you by:
[![Quantum Leaps](https://www.state-machine.com/attachments/logo_ql_400.png)](https://www.state-machine.com)
<hr>

[![GitHub](https://img.shields.io/github/license/QuantumLeaps/ai-statechart)](https://github.com/QuantumLeaps/ai-statechart/blob/main/LICENSE)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24519411.svg)](https://doi.org/10.5281/zenodo.24519411)

# AI Statechart: the Linear Statechart Notation

Interactive demonstration of the **Linear Statechart Notation**, a way to draw hierarchical state machines (statecharts) as an outline of rows, computed from a model that stores no geometry, so that people and AI assistants can work on the same model.

- **Try it:** https://www.state-machine.com/ai-statechart
- **Paper:** M. Samek, "State Machine Modeling for the AI Era: The Linear Statechart Notation", preprint, 2026. https://doi.org/10.5281/zenodo.24519411
- **Origin:** "Linear statechart notation", blog post, 2010. https://www.state-machine.com/linear-statechart-notation

# The idea

- A state is a row with its name and a horizontal line, its *rail*. Nesting is shown by indentation, as in a file explorer.
- Everything a state does is listed under its name: entry and exit actions, initial transition, history, and every transition it handles.
- Every transition leaves its row, runs up or down in a vertical lane, and ends with an arrowhead on the rail of its target state. Transitions to the same state share one lane, like wires in a schematic.
- Composite states fold and unfold like code blocks in an editor.
- The drawing is computed from the model by fixed rules, so it changes only where the model changes, and a model written or edited by an AI assistant can be drawn immediately.

# What is here

| Path | Content |
|---|---|
| `index.html` | The demonstration: open it in a web browser (no build, no server needed). |
| `js/qmodel-xml.js` | Reader, canonical writer and checker of the QModel file format (plain JavaScript, also runs in Node). |
| `js/ops.js` | Editing operations in the drawing as minimal edits of the model text. |
| `schema/qmodel-1.xsd` | XML schema of the QModel file format. |
| `models/` | The example models of the paper: the toaster oven, the PELICAN crossing and the qhsmtst test model. |

In the demonstration you can pick an example or open a `.qmodel` file, fold states, switch levels, focus on states and transitions, and edit the model text: the drawing follows every edit.

# Status

This is the first public version (November 2026), the reference implementation described in the paper. A guided tour of the paper's figures and support for trying the notation with your own AI assistant are coming next. Feedback is welcome (see below).

# Licensing
The code is [licensed](LICENSE) under the MIT open source license. The notation itself is disclosed as prior art in the paper and is free for anyone to use.

# Comments/Discussion
If you'd like to discuss the Linear Statechart Notation or this demo, please use the ["Issues" tab](https://github.com/QuantumLeaps/ai-statechart/issues).

# How to Help this Project?
Please feel free to clone, fork, and make pull requests to improve the demo.
If you like this project, please give it a star
(in the upper-right corner of your browser window):

<p align="center"><img src="img/github-star.jpg"/></p>
