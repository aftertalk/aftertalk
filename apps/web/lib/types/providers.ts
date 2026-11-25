export type ProviderKind = 'speech' | 'diarization' | 'llm';
export type ProviderAdapter = 'openai-compatible' | 'pyannote-ai';
export type DataLocation = 'eu' | 'us' | 'own_network' | 'other';

/** A provider connection as the browser sees it: the key itself never leaves the server. */
export interface ProviderConnection {
  id: string;
  kind: ProviderKind;
  adapter: ProviderAdapter;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  dataLocation: DataLocation;
  /** Speech only: whether the last test returned word times; null when never tested. */
  wordTimes: boolean | null;
  /** Used by at least one project, so it cannot be removed. */
  inUse: boolean;
  createdAt: string;
}

export interface ProviderChoice {
  slot: ProviderKind;
  connectionId: string;
  model: string | null;
}

/** What a project can pick for a slot: the connections of that kind in its organisation. */
export interface ProviderOption {
  id: string;
  name: string;
  kind: ProviderKind;
  dataLocation: DataLocation;
}

export interface ProjectProviders {
  choices: ProviderChoice[];
  options: ProviderOption[];
}

export interface ProjectReadiness {
  roles: boolean;
  templates: boolean;
  categories: boolean;
  speech: boolean;
  llm: boolean;
  diarization: boolean;
  /** All but `diarization`. */
  canUpload: boolean;
}
