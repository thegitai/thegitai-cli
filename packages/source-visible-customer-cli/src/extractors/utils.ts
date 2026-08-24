export function pushSignature(
  signatures: string[],
  line: string | undefined,
): void {
  const normalized = String(line ?? '').trim();
  if (!normalized) return;
  if (!signatures.includes(normalized)) {
    signatures.push(normalized);
  }
}


export function getNamedFieldText(node: any | null, fieldName: string): string {
  return node?.childForFieldName(fieldName)?.text ?? '';
}


export function findNamedChild(
  node: any | null,
  allowedTypes: Set<string>,
): any | null {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && allowedTypes.has(child.type)) {
      return child;
    }
  }
  return null;
}


export function getIdentifierLikeText(node: any | null): string {
  if (!node) return '';
  const directName =
    getNamedFieldText(node, 'name') ||
    getNamedFieldText(node, 'declarator') ||
    getNamedFieldText(node, 'pattern');
  if (directName) return directName;
  const identifierNode = findNamedChild(
    node,
    new Set([
      'identifier',
      'property_identifier',
      'type_identifier',
      'variable_name',
      'name',
      'namespace_name',
    ]),
  );
  return identifierNode?.text ?? '';
}


export function getParametersText(
  node: any | null,
  fallback: string = '()',
): string {
  if (!node) return fallback;
  const fromField =
    getNamedFieldText(node, 'parameters') ||
    getNamedFieldText(node, 'parameter') ||
    getNamedFieldText(node, 'arguments');
  if (fromField) return fromField;
  const paramsNode = findNamedChild(
    node,
    new Set(['formal_parameters', 'parameters', 'parameter_list']),
  );
  return paramsNode?.text ?? fallback;
}


export function getVariableNameFromFunctionNode(node: any | null): string {
  const parent = node?.parent;
  if (!parent || parent.type !== 'variable_declarator') {
    return '';
  }
  return getNamedFieldText(parent, 'name') || getIdentifierLikeText(parent);
}
