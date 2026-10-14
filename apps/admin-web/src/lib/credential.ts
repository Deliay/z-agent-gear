export function maskCredential(value: string): string {
  if (!value) return ''
  // 短凭据整体掩码，避免 first3+last4 泄露（近似）完整原值
  if (value.length <= 8) return '****'
  return value.slice(0, 3) + '****' + value.slice(-4)
}
