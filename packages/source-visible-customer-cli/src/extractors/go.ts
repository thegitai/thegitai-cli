import {
  getIdentifierLikeText,
  getNamedFieldText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addGoSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'function_declaration':
      pushSignature(
        signatures,
        `func ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
    case 'method_declaration':
      pushSignature(
        signatures,
        `method ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
    case 'type_spec': {
      const name = getIdentifierLikeText(node);
      const typeText = getNamedFieldText(node, 'type');
      if (!name) return;
      if (typeText.startsWith('struct')) {
        pushSignature(signatures, `type ${name} struct`);
      } else if (typeText.startsWith('interface')) {
        pushSignature(signatures, `type ${name} interface`);
      } else {
        pushSignature(signatures, `type ${name}`);
      }
      return;
    }
  }
}
