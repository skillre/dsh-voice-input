//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-host-stt-tencent`.
* @module @deepseek-ai/dsh-host-stt-tencent/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-host-stt-tencent";
/** Cordis companion plugin name. */
const name = "stt-tencent-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the proxy owns no dispatch-acknowledged action; the
* upstream call's success/failure is the whole observable, surfaced directly
* to the caller.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
