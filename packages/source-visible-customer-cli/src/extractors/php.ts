import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addPhpSignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_declaration':
      pushSignature(signatures, `class ${getIdentifierLikeText(node)}`);
      return;
    case 'interface_declaration':
      pushSignature(signatures, `interface ${getIdentifierLikeText(node)}`);
      return;
    case 'trait_declaration':
      pushSignature(signatures, `trait ${getIdentifierLikeText(node)}`);
      return;
    case 'function_definition':
      pushSignature(
        signatures,
        `function ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
    case 'method_declaration':
      pushSignature(
        signatures,
        `method ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
  }
}
