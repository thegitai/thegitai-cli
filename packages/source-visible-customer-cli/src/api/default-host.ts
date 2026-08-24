/**
 * The one official TheGitAI host, for both the API and the website.
 *
 * Deliberately a single exported constant rather than a literal repeated at
 * each call site: the invariant it carries is that the published package
 * cannot be pointed at a clone host, and an invariant defended in four places
 * is one bad merge away from not being defended at all. There is no
 * environment override here on purpose — internal development uses private
 * tooling, not a customer-visible runtime override path.
 */
export const DEFAULT_THEGITAI_HOST = 'https://thegit.ai';
