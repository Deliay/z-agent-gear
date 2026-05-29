export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  
  let queryIndex = 0;
  for (let i = 0; i < lowerTarget.length && queryIndex < lowerQuery.length; i++) {
    if (lowerTarget[i] === lowerQuery[queryIndex]) {
      queryIndex++;
    }
  }
  
  return queryIndex === lowerQuery.length;
}

export function fuzzyMatchWithHighlight(query: string, target: string): { matched: boolean; indices: number[] } {
  if (!query) return { matched: true, indices: [] };
  
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  
  const indices: number[] = [];
  let queryIndex = 0;
  
  for (let i = 0; i < lowerTarget.length && queryIndex < lowerQuery.length; i++) {
    if (lowerTarget[i] === lowerQuery[queryIndex]) {
      indices.push(i);
      queryIndex++;
    }
  }
  
  return {
    matched: queryIndex === lowerQuery.length,
    indices,
  };
}
