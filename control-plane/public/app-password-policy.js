export const passwordRule = '密码至少 8 位，且包含大写字母、小写字母、数字、特殊字符中的至少三类'
export function strongPassword(value) {
  return typeof value === 'string' && [...value].length >= 8 && [/\p{Lu}/u, /\p{Ll}/u, /[0-9]/, /[\p{P}\p{S}]/u].filter(rule => rule.test(value)).length >= 3
}
export const requiresPasswordChange = user => user?.username !== 'admin' && user?.mustChangePassword === true
