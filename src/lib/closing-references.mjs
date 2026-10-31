// @ts-check

// GitHub closes an issue when a pull request merged into the default branch
// names it after one of these keywords. Release Please renders every
// footer-form reference in a squashed commit ("Refs #187") as
// ", closes [#187](…)" in the version pull request it writes, so merging
// that pull request would close issues the original change only referenced.
const keyword = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`
const issue = String.raw`(?:\[#\d+\]|#\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)`
const closingReference = new RegExp(`${keyword}(:?\\s+)(?=${issue})`, 'gi')

/**
 * Replace each GitHub closing keyword that precedes an issue reference with
 * "refs", so the text still links the issue but merging it closes nothing.
 * @param {string} text
 */
export function neutralizeClosingReferences(text) {
  return text.replace(closingReference, (_match, separator) => `refs${separator}`)
}
