import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addRustSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'struct_item':
      pushSignature(signatures, `struct ${getIdentifierLikeText(node)}`);
      return;
    case 'enum_item':
      pushSignature(signatures, `enum ${getIdentifierLikeText(node)}`);
      return;
    case 'trait_item':
      pushSignature(signatures, `trait ${getIdentifierLikeText(node)}`);
      return;
    case 'function_item':
      pushSignature(
        signatures,
        `fn ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
  }
}
