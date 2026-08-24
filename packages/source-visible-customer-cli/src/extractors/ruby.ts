import {
  getIdentifierLikeText,
  getParametersText,
  pushSignature,
} from './utils.js';


export function addRubySignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'class':
    case 'module':
      pushSignature(signatures, `${node.type} ${getIdentifierLikeText(node)}`);
      return;
    case 'method':
    case 'singleton_method':
      pushSignature(
        signatures,
        `def ${getIdentifierLikeText(node)}${getParametersText(node)}`,
      );
      return;
  }
}
