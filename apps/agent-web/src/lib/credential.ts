export function maskCredential(value: string): string {
  if (!value || value.length <= 7) {
    return value?.slice(0, 3) + '****' + value?.slice(-4) ?? ''
  }
  return value.slice(0, 3) + '****' + value.slice(-4)
}
