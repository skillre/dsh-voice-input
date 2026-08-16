/**
 * Voice input client plugin: mounts the mic control and its configuration
 * card entirely through dsh's public plugin surface — no core package is
 * modified or rebuilt:
 * - `conversation.input.left` (official tool-row slot): the mic button,
 *   committing through the public `inputActions.setDraft` face.
 * - `settings.plugin.item` (official plugins-settings card slot): the
 *   engine/AppId card, reading and writing the host plugin's own
 *   `/stt/config` route (no settings-namespace whitelist involved).
 * The host STT proxy (`@deepseek-ai/dsh-host-stt-tencent`) holds the Tencent
 * credentials; this package only records, recognizes, configures, and writes
 * the draft.
 * @module @deepseek-ai/dsh-client-ui-voice-input
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left slot).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-settings-plugins SlotMap merge (the plugin.item card slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { VoiceConfigCard, VoiceToolRowButton } from './VoiceInputButton.tsx'
import { en, zh, type VoiceKey } from './locales.ts'

export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice input's copy (tool-row tooltip + settings card). */
    'voice.input': VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice.input'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/** Injected share of both mount forms: nothing beyond the owner/runtime kit. */
export interface VoiceInputInjected {}

/**
 * Client plugin body: register the dictionaries and both mount points. The
 * tool row hosts the mic; the settings section hosts the configuration card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-input: dictionaries')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-input',
    locale: NS,
    inject: (_sessionId: SessionId): VoiceInputInjected => ({}),
  }, VoiceToolRowButton))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'voice-input-config',
    order: 30,
    locale: NS,
    inject: (): VoiceInputInjected => ({}),
  }, VoiceConfigCard))
}
