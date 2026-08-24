import {
  getIdentifierLikeText,
  getParametersText,
  getVariableNameFromFunctionNode,
  pushSignature,
} from './utils.js';


export function addJsFamilySignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_declaration':
      pushSignature(signatures, `class ${getIdentifierLikeText(node)}`);
      return;
    case 'interface_declaration':
      pushSignature(signatures, `interface ${getIdentifierLikeText(node)}`);
      return;
    case 'type_alias_declaration':
      pushSignature(signatures, `type ${getIdentifierLikeText(node)}`);
      return;
    case 'enum_declaration':
      pushSignature(signatures, `enum ${getIdentifierLikeText(node)}`);
      return;
    case 'function_declaration':
    case 'function_signature':
      pushSignature(
        signatures,
        `function ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
    case 'method_definition':
    case 'method_signature':
      pushSignature(
        signatures,
        `method ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
    case 'arrow_function':
    case 'function_expression': {
      const name = getVariableNameFromFunctionNode(node);
      if (name) {
        pushSignature(signatures, `function ${name}${getParametersText(node)}`);
      }
      return;
    }
  }
}
