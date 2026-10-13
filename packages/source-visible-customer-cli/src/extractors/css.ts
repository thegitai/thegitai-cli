import { findNamedChild, pushSignature } from './utils.js';


export function addCssFamilySignature(node: any, signatures: string[]): void {
  switch (node.type) {
    case 'rule_set': {
      const selectors = findNamedChild(node, new Set(['selectors']));
      if (selectors) {
        pushSignature(signatures, `${selectors.text} { ... }`);
      }
      return;
    }
  }
}
