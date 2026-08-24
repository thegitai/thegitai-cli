import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addCSharpSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'struct_declaration':
    case 'enum_declaration':
    case 'record_declaration':
      pushSignature(
        signatures,
        `${node.type.split('_')[0]} ${getIdentifierLikeText(node)}`,
      );
      return;
    case 'method_declaration':
    case 'constructor_declaration':
      pushSignature(
        signatures,
        `method ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
  }
}
