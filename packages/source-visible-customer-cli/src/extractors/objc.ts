import { getIdentifierLikeText, pushSignature } from './utils.js';


export function addObjcSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_interface':
    case 'class_implementation':
    case 'protocol_declaration':
      pushSignature(signatures, `class ${getIdentifierLikeText(node)}`);
      return;
    case 'method_declaration':
    case 'method_definition':
      pushSignature(signatures, `method ${getIdentifierLikeText(node)}`);
      return;
  }
}
