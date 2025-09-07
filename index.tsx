/* tslin:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html, PropertyValues} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import {supabase} from './supabase-client';
import type {Session as SupabaseSession} from '@supabase/supabase-js';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  // FIX: The 'isFinal' property on Transcription has been removed from the API.
  // The local state is updated to reflect this change.
  @state() private transcripts: Array<{
    speaker: string;
    text: string;
  }> = [];
  @state() private supabaseSession: SupabaseSession | null = null;
  @state() private currentSessionId: string | null = null;
  @state() private isHistoryPanelOpen = false;
  @state() private isProfileMenuOpen = false;
  @state() private chatHistory: Record<
    string,
    Array<{speaker: string; text: string; created_at: string}>
  > = {};

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new window.AudioContext({sampleRate: 16000});
  private outputAudioContext = new window.AudioContext({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      background-color: #000;
      overflow: hidden;
      color: white;
      font-family: 'Google Sans', sans-serif, system-ui;
    }

    .login-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 20px;
      background-color: #000;
    }

    .login-container h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      font-weight: 300;
      color: #e0e0e0;
    }

    .login-container p {
      font-size: 1.1rem;
      margin-bottom: 2.5rem;
      color: #aaa;
      max-width: 500px;
    }

    .login-container button {
      background-color: #212121;
      color: #e0e0e0;
      border: 1px solid #444;
      padding: 14px 28px;
      font-size: 1rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition:
        background-color 0.3s,
        border-color 0.3s,
        transform 0.2s;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    }

    .login-container button:hover {
      background-color: #333;
      border-color: #666;
      transform: translateY(-2px);
    }

    .profile-menu-container {
      position: absolute;
      top: 15px;
      right: 15px;
      z-index: 30;
    }

    .profile-button {
      background: rgba(40, 40, 40, 0.8);
      border: 1px solid #444;
      border-radius: 50%;
      width: 44px;
      height: 44px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.3s;
    }

    .profile-button:hover {
      background: #333;
    }

    .profile-button svg {
      fill: white;
      width: 24px;
      height: 24px;
    }

    .profile-dropdown {
      position: absolute;
      top: 55px;
      right: 0;
      background-color: #282828;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      width: 180px;
      overflow: hidden;
      display: none;
      flex-direction: column;
      border: 1px solid #444;
    }

    .profile-dropdown.open {
      display: flex;
    }

    .dropdown-item {
      padding: 12px 16px;
      color: #e0e0e0;
      cursor: pointer;
      background: none;
      border: none;
      text-align: left;
      font-size: 0.95rem;
      width: 100%;
      transition: background-color 0.2s;
    }

    .dropdown-item:hover {
      background-color: #3a3a3a;
    }

    .app-container {
      display: flex;
      flex-direction: column; /* Vertical layout for all screens */
      width: 100%;
      height: 100%;
      position: relative;
    }

    .visualizer-container {
      flex: 1;
      min-height: 250px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    .transcripts-container {
      flex: 1;
      background-color: #121212;
      margin: 10px;
      border-radius: 12px;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      border: 1px solid #333;
      scrollbar-width: thin;
      scrollbar-color: #555 #121212;
    }

    .transcripts-container::-webkit-scrollbar {
      width: 8px;
    }

    .transcripts-container::-webkit-scrollbar-track {
      background: #121212;
    }

    .transcripts-container::-webkit-scrollbar-thumb {
      background-color: #555;
      border-radius: 4px;
    }

    .transcript-line {
      padding: 10px 15px;
      border-radius: 18px;
      font-size: 1rem;
      line-height: 1.5;
      max-width: 85%;
      color: white;
      word-wrap: break-word;
    }

    .transcript-line strong {
      display: block;
      margin-bottom: 4px;
      font-size: 0.8rem;
      opacity: 0.8;
      font-weight: bold;
    }

    .transcript-line.candidate {
      align-self: flex-end;
      background-color: #005a9c;
      border-bottom-right-radius: 4px;
    }

    .transcript-line.examiner {
      align-self: flex-start;
      background-color: #3a3a3a;
      border-bottom-left-radius: 4px;
    }

    .history-panel {
      position: fixed;
      top: 0;
      right: -100%; /* Start off-screen */
      width: 90%; /* More width on mobile */
      max-width: 400px;
      height: 100vh;
      background-color: #1a1a1a;
      box-shadow: -5px 0 15px rgba(0, 0, 0, 0.5);
      transition: right 0.4s ease-in-out;
      z-index: 100;
      display: flex;
      flex-direction: column;
    }

    .history-panel.open {
      right: 0; /* Slide in */
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      border-bottom: 1px solid #333;
    }

    .history-header h2 {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 500;
    }

    .history-header button {
      background: none;
      border: none;
      color: white;
      font-size: 2rem;
      cursor: pointer;
      line-height: 1;
      padding: 0 5px;
    }

    .history-content {
      flex-grow: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .history-session {
      border: 1px solid #444;
      border-radius: 8px;
      padding: 15px;
      background-color: #242424;
    }

    .history-session h3 {
      margin-top: 0;
      font-size: 0.9rem;
      color: #aaa;
      border-bottom: 1px solid #444;
      padding-bottom: 10px;
      margin-bottom: 10px;
    }

    .history-message {
      margin-bottom: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      max-width: 95%;
      word-wrap: break-word;
      display: flex;
      flex-direction: column;
    }

    .history-message.candidate {
      background-color: #005a9c;
      align-self: flex-end;
    }

    .history-message.examiner {
      background-color: #3a3a3a;
      align-self: flex-start;
    }

    .history-message strong {
      display: block;
      font-size: 0.8rem;
      opacity: 0.8;
      margin-bottom: 4px;
    }

    .history-message p {
      margin: 0;
      font-size: 0.95rem;
      line-height: 1.4;
    }

    /* Tablet and Desktop Styles */
    @media (min-width: 768px) {
      .login-container h1 {
        font-size: 3.5rem;
      }

      .login-container p {
        font-size: 1.2rem;
      }

      /* On desktop, keep the column layout but center the transcript box */
      .transcripts-container {
        margin: 20px auto; /* Center horizontally, add vertical margin */
        width: 90%;
        max-width: 800px; /* Constrain width for readability */
      }

      .history-panel {
        width: 400px;
      }
    }
  `;

  constructor() {
    super();
    supabase.auth.getSession().then(({data: {session}}) => {
      this.supabaseSession = session;
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      this.supabaseSession = session;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.body.removeEventListener('click', this.handleOutsideClick);
  }

  updated(changedProperties: PropertyValues) {
    if (changedProperties.has('transcripts')) {
      const container = this.shadowRoot?.querySelector('.transcripts-container');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }

    if (changedProperties.has('supabaseSession')) {
      if (this.supabaseSession) {
        if (!this.client) {
          this.initClient();
        }
        this.fetchHistory();
      } else {
        this.cleanup();
      }
    }
  }

  private cleanup() {
    this.stopRecording();
    if (this.session) {
      this.session.close();
    }
    this.client = null;
    this.session = null;
    this.transcripts = [];
    this.chatHistory = {};
    this.isHistoryPanelOpen = false;
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);
  }

  private async saveCurrentSessionHistory() {
    if (
      !this.supabaseSession ||
      !this.currentSessionId ||
      this.transcripts.length === 0
    ) {
      return;
    }

    // NOTE: For this to work, you must create a 'transcripts' table in your Supabase project.
    // Table schema:
    // - id: uuid (Primary Key)
    // - created_at: timestamptz
    // - user_id: uuid (Foreign Key to auth.users.id)
    // - session_id: uuid
    // - speaker: text
    // - text: text
    // You also need to enable Row Level Security (RLS) on this table and
    // create policies that allow authenticated users to insert and read their own transcripts.
    const transcriptsToSave = this.transcripts.map(({speaker, text}) => ({
      user_id: this.supabaseSession!.user.id,
      session_id: this.currentSessionId!,
      speaker,
      text,
    }));

    const {error} = await supabase.from('transcripts').insert(transcriptsToSave);

    if (error) {
      console.error('Error saving session history:', error.message);
    }
  }

  private async fetchHistory() {
    if (!this.supabaseSession) return;

    const {data, error} = await supabase
      .from('transcripts')
      .select('session_id, speaker, text, created_at')
      .eq('user_id', this.supabaseSession.user.id)
      .order('created_at', {ascending: true});

    if (error) {
      console.error('Error fetching history:', error.message);
      return;
    }

    if (data) {
      const groupedHistory = data.reduce((acc, item) => {
        const {session_id} = item;
        if (!acc[session_id]) {
          acc[session_id] = [];
        }
        acc[session_id].push(item);
        return acc;
      }, {});
      this.chatHistory = groupedHistory;
    }
  }

  private async initSession() {
    if (!this.client) return;
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            console.log('Session opened.');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const inputTranscription =
              message.serverContent?.inputTranscription;
            if (inputTranscription?.text) {
              const lastTranscript =
                this.transcripts[this.transcripts.length - 1];
              // FIX: The 'isFinal' property on Transcription has been removed.
              // Assuming that we should update the last transcript if it's from the same speaker.
              if (lastTranscript?.speaker === 'Candidate') {
                lastTranscript.text += inputTranscription.text;
                this.transcripts = [...this.transcripts];
              } else {
                const newTranscript = {
                  speaker: 'Candidate',
                  text: inputTranscription.text,
                };
                this.transcripts = [...this.transcripts, newTranscript];
              }
            }

            const outputTranscription =
              message.serverContent?.outputTranscription;
            if (outputTranscription?.text) {
              const lastTranscript =
                this.transcripts[this.transcripts.length - 1];
              // FIX: The 'isFinal' property on Transcription has been removed.
              // Assuming that we should append to the last transcript if it's from the same speaker.
              if (lastTranscript?.speaker === 'Examiner') {
                lastTranscript.text += outputTranscription.text;
                this.transcripts = [...this.transcripts];
              } else {
                const newTranscript = {
                  speaker: 'Examiner',
                  text: outputTranscription.text,
                };
                this.transcripts = [...this.transcripts, newTranscript];
              }
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error(e);
          },
          onclose: (e: CloseEvent) => {
            console.log('Session closed:', e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
          inputAudioTranscription: {languageCodes: ['en-US'], model: 'chirp'},
          outputAudioTranscription: {languageCodes: ['en-US']},
          // FIX: The `interruptionConfig` property was previously nested inside a `dialogConfig` object, which caused a type error.
          // It is now a direct property of the `config` object to align with the type definitions.
          interruptionConfig: {threshold: {delaySeconds: 5.0}},
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.transcripts = [];
    this.currentSessionId = crypto.randomUUID();

    await this.initSession();
    if (!this.session) {
      console.error('Could not start new session.');
      return;
    }

    this.inputAudioContext.resume();

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
    } catch (err) {
      console.error('Error starting recording:', err);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.saveCurrentSessionHistory();

    this.isRecording = false;

    if (this.session) {
      this.session.close();
      this.session = null;
    }

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private handleOutsideClick = (event: MouseEvent) => {
    const container = this.shadowRoot?.querySelector('.profile-menu-container');
    if (container && !event.composedPath().includes(container)) {
      this.isProfileMenuOpen = false;
      document.body.removeEventListener('click', this.handleOutsideClick);
    }
  };

  private toggleProfileMenu() {
    this.isProfileMenuOpen = !this.isProfileMenuOpen;
    if (this.isProfileMenuOpen) {
      setTimeout(() => {
        document.body.addEventListener('click', this.handleOutsideClick);
      }, 0);
    } else {
      document.body.removeEventListener('click', this.handleOutsideClick);
    }
  }

  private openHistoryPanel() {
    this.isHistoryPanelOpen = true;
    this.isProfileMenuOpen = false; // Close menu after action
    this.fetchHistory();
  }

  private closeHistoryPanel() {
    this.isHistoryPanelOpen = false;
  }

  private async signInWithGoogle() {
    await supabase.auth.signInWithOAuth({provider: 'google'});
  }

  private async signOut() {
    await supabase.auth.signOut();
  }

  private renderLogin() {
    return html`
      <div class="login-container">
        <h1>Live Audio Experience</h1>
        <p>
          Engage in a seamless, real-time conversation. Sign in with your Google
          account to begin.
        </p>
        <button @click=${this.signInWithGoogle}>
          <svg
            height="24"
            width="24"
            viewBox="0 0 24 24"
            fill="currentColor">
            <path
              d="M21.35,11.1H12.18V13.83H18.69C18.36,17.64 15.19,19.27 12.19,19.27C8.36,19.27 5,16.25 5,12C5,7.9 8.2,4.73 12.19,4.73C15.29,4.73 17.1,6.7 17.1,6.7L19,4.72C19,4.72 16.56,2 12.19,2C6.42,2 2.03,6.8 2.03,12C2.03,17.05 6.16,22 12.19,22C17.6,22 21.5,18.33 21.5,12.91C21.5,11.76 21.35,11.1 21.35,11.1V11.1Z"></path>
          </svg>
          Sign in with Google
        </button>
      </div>
    `;
  }

  private renderHistoryPanel() {
    const sortedSessionIds = Object.keys(this.chatHistory).sort((a, b) => {
      const dateA = new Date(this.chatHistory[a][0].created_at).getTime();
      const dateB = new Date(this.chatHistory[b][0].created_at).getTime();
      return dateB - dateA; // Sort descending
    });

    return html`
      <div class="history-panel ${this.isHistoryPanelOpen ? 'open' : ''}">
        <div class="history-header">
          <h2>Chat History</h2>
          <button @click=${this.closeHistoryPanel}>&times;</button>
        </div>
        <div class="history-content">
          ${sortedSessionIds.length === 0
            ? html`<p>No history found.</p>`
            : sortedSessionIds.map(
                (sessionId) => html`
                  <div class="history-session">
                    <h3>
                      Session from
                      ${new Date(
                        this.chatHistory[sessionId][0].created_at,
                      ).toLocaleString()}
                    </h3>
                    ${this.chatHistory[sessionId].map(
                      (msg) => html`
                        <div
                          class="history-message ${msg.speaker.toLowerCase()}">
                          <strong>${msg.speaker}</strong>
                          <p>${msg.text}</p>
                        </div>
                      `,
                    )}
                  </div>
                `,
              )}
        </div>
      </div>
    `;
  }

  private renderApp() {
    return html`
      <div class="app-container">
        <div class="profile-menu-container">
          <button
            class="profile-button"
            @click=${this.toggleProfileMenu}
            aria-label="Profile menu">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 0 24 24"
              width="24px">
              <path d="M0 0h24v24H0V0z" fill="none" />
              <path
                d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          </button>
          <div class="profile-dropdown ${this.isProfileMenuOpen ? 'open' : ''}">
            <button class="dropdown-item" @click=${this.openHistoryPanel}>
              History
            </button>
            <button class="dropdown-item" @click=${this.signOut}>Logout</button>
          </div>
        </div>

        ${this.renderHistoryPanel()}
        <div class="visualizer-container">
          <gdm-audio-visualizer
            .inputNode=${this.inputNode}
            .outputNode=${this.outputNode}
            ?isRecording=${this.isRecording}
            @click=${this.toggleRecording}></gdm-audio-visualizer>
        </div>
        <div class="transcripts-container">
          ${this.transcripts.map(
            (t) => html`
              <div class="transcript-line ${t.speaker.toLowerCase()}">
                <strong>${t.speaker}</strong>
                <div>${t.text}</div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  render() {
    return this.supabaseSession ? this.renderApp() : this.renderLogin();
  }
}
