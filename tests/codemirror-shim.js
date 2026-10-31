// Stands in for codemirror/lib/codemirror.js in the note test bundle: the real
// CodeMirror, whose fromTextArea goes to a hook the harness sets on the context
// before the bundle runs. A real editor needs a real DOM.
'use strict';

// by relative path: the aliased one would resolve back to this file
const CodeMirror = require('../node_modules/codemirror/lib/codemirror.js');

CodeMirror.fromTextArea = (...args) => globalThis.fromTextArea(...args);
globalThis.CodeMirror = CodeMirror;

module.exports = CodeMirror;
