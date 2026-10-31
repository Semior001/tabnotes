// CodeMirror.keyMap exists at runtime but @types/codemirror does not declare it.
import 'codemirror';

declare module 'codemirror' {
  const keyMap: Record<string, KeyMap>;
}
