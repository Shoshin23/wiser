// The card-schema seam: the contract between backend and the glasses webapp.
// Keep this in sync with glasses-webapp (it mirrors these shapes).

export interface Card {
  title: string;
  summary: string;
}

export interface AskResponse {
  transcript: string;
  answer: string;
  /** base64 WAV, one per <=200-char chunk, in playback order */
  audioChunks: string[];
  card: Card;
}
