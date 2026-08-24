import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addJavaSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
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
