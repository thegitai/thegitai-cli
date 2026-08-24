import {
  findNamedChild,
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addCppFamilySignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class_specifier':
    case 'struct_specifier':
    case 'enum_specifier':
      pushSignature(
        signatures,
        `${node.type.split('_')[0]} ${getIdentifierLikeText(node)}`,
      );
      return;
    case 'function_definition':
    case 'declaration': {
      const funcDeclarator = findNamedChild(
        node,
        new Set(['function_declarator']),
      );
      if (funcDeclarator) {
        pushSignature(
          signatures,
          `function ${getIdentifierLikeText(funcDeclarator)}${getParametersText(funcDeclarator)}`,
        );
      }
      return;
    }
  }
}
