import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addPythonSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_definition':
      pushSignature(signatures, `class ${getIdentifierLikeText(node)}`);
      return;
    case 'function_definition':
      pushSignature(
        signatures,
        `def ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
  }
}
