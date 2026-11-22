export type ChannelRoles = Record<`channel_${number}`, string>;

export interface PresetSpeaker {
  label: string;
  channel: number;
}

/**
 * Seeded and legacy presets store each speaker as a serialized JSON object like
 * {"id":"agent","label":"Konsultant","channel":1}, while presets created in the UI
 * store the plain label. Normalizes either shape to label + channel, ordered so
 * channel 0 always comes first (legacy arrays are not channel-ordered).
 */
export function parsePresetSpeakers(speakers: string[]): PresetSpeaker[] {
  return speakers
    .map((speaker, index) => {
      if (speaker?.startsWith('{')) {
        try {
          const parsed = JSON.parse(speaker) as { label?: unknown; channel?: unknown };
          return {
            label: typeof parsed.label === 'string' ? parsed.label : speaker,
            channel: typeof parsed.channel === 'number' ? parsed.channel : index,
          };
        } catch {
          // not JSON after all — treat as a plain label
        }
      }
      return { label: speaker ?? '', channel: index };
    })
    .sort((a, b) => a.channel - b.channel);
}

export function speakersToChannelRoles(speakers: string[]): ChannelRoles {
  const roles: ChannelRoles = {};
  speakers.forEach((speaker, i) => {
    roles[`channel_${i}`] = speaker;
  });
  return roles;
}

export function channelRolesToSpeakers(roles: ChannelRoles): string[] {
  return Object.entries(roles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}
