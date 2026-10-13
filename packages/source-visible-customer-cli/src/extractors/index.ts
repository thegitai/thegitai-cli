import { addCppFamilySignature } from './cpp.js';
import { addCSharpSignature } from './csharp.js';
import { addCssFamilySignature } from './css.js';
import { addGoSignature } from './go.js';
import { addJavaSignature } from './java.js';
import { addJsFamilySignature } from './javascript.js';
import { addObjcSignature } from './objc.js';
import { addPhpSignature } from './php.js';
import { addPythonSignature } from './python.js';
import { addRubySignature } from './ruby.js';
import { addRustSignature } from './rust.js';


export function addSignatureForNode(
  node: any,
  languageId: string,
  signatures: string[],
): void {
  switch (languageId) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      addJsFamilySignature(node, signatures);
      return;
    case 'python':
      addPythonSignature(node, signatures);
      return;
    case 'go':
      addGoSignature(node, signatures);
      return;
    case 'rust':
      addRustSignature(node, signatures);
      return;
    case 'php':
      addPhpSignature(node, signatures);
      return;
    case 'java':
      addJavaSignature(node, signatures);
      return;
    case 'c':
    case 'cpp':
      addCppFamilySignature(node, signatures);
      return;
    case 'csharp':
      addCSharpSignature(node, signatures);
      return;
    case 'objc':
      addObjcSignature(node, signatures);
      return;
    case 'ruby':
      addRubySignature(node, signatures);
      return;
    case 'css':
    case 'scss':
      addCssFamilySignature(node, signatures);
      return;
  }
}
