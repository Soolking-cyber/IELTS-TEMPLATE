/* tslint:disable */
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
  @state() private transcripts: Array<{
    speaker: string;
    text: string;
    isFinal?: boolean;
  }> = [];
  @state() private supabaseSession: SupabaseSession | null = null;
  @state() private currentSessionId: string | null = null;
  @state() private isHistoryPanelOpen = false;
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
    }

    .login-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 20px;
    }

    .login-container h1 {
      font-size: 3rem;
      margin-bottom: 1rem;
      font-weight: 300;
    }

    .login-container p {
      font-size: 1.2rem;
      margin-bottom: 2rem;
      color: #ccc;
    }

    .login-container button {
      background-color: #4285f4; /* Google Blue */
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 1rem;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 0.3s;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .login-container button:hover {
      background-color: #357ae8;
    }

    .header-controls {
      position: absolute;
      top: 20px;
      right: 20px;
      display: flex;
      gap: 10px;
      z-index: 20;
    }

    .logout-button,
    .history-button {
      background: #3a3a3a;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 0.3s;
    }

    .logout-button:hover,
    .history-button:hover {
      background: #555;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .visualizer-container {
      flex: 3; /* Takes ~60% of the space */
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    .transcripts-container {
      flex: 2; /* Takes ~40% of the space */
      background-color: #121212;
      margin: 20px;
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
      max-width: 75%;
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
      background-color: #005a9c; /* Professional blue */
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
      right: -400px; /* Start off-screen */
      width: 400px;
      height: 100vh;
      background-color: #1a1a1a;
      box-shadow: -5px 0 15px rgba(0, 0, 0, 0.5);
      transition: right 0.4s ease-in-out;
      z-index: 15;
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

    this.initSession();
  }

  private async saveTranscript(speaker: string, text: string) {
    if (!this.supabaseSession || !this.currentSessionId) return;

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
    const {error} = await supabase.from('transcripts').insert({
      user_id: this.supabaseSession.user.id,
      session_id: this.currentSessionId,
      speaker,
      text,
    });

    if (error) {
      console.error('Error saving transcript:', error.message);
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
            const isFinalInput =
              (inputTranscription as any)?.status === 'FINAL';
            if (inputTranscription?.text) {
              const lastTranscript =
                this.transcripts[this.transcripts.length - 1];
              if (
                lastTranscript?.speaker === 'Candidate' &&
                !lastTranscript.isFinal
              ) {
                lastTranscript.text += inputTranscription.text;
                if (isFinalInput) {
                  lastTranscript.isFinal = true;
                  this.saveTranscript('Candidate', lastTranscript.text);
                }
                this.transcripts = [...this.transcripts];
              } else {
                const newTranscript = {
                  speaker: 'Candidate',
                  text: inputTranscription.text,
                  isFinal: isFinalInput,
                };
                this.transcripts = [...this.transcripts, newTranscript];
                if (isFinalInput) {
                  this.saveTranscript('Candidate', newTranscript.text);
                }
              }
            }

            const outputTranscription =
              message.serverContent?.outputTranscription;
            const isFinalOutput =
              (outputTranscription as any)?.status === 'FINAL';
            if (outputTranscription?.text) {
              const lastTranscript =
                this.transcripts[this.transcripts.length - 1];
              if (
                lastTranscript?.speaker === 'Examiner' &&
                !lastTranscript.isFinal
              ) {
                lastTranscript.text += outputTranscription.text;
                if (isFinalOutput) {
                  lastTranscript.isFinal = true;
                  this.saveTranscript('Examiner', lastTranscript.text);
                }
                this.transcripts = [...this.transcripts];
              } else {
                const newTranscript = {
                  speaker: 'Examiner',
                  text: outputTranscription.text,
                  isFinal: isFinalOutput,
                };
                this.transcripts = [...this.transcripts, newTranscript];
                if (isFinalOutput) {
                  this.saveTranscript('Examiner', newTranscript.text);
                }
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
          // FIX: The 'interruption' property is now 'interruptionConfig' and the 'delaySeconds' setting is nested within a 'threshold' object.
          interruptionConfig: {threshold: {delaySeconds: 1.0}},
          inputAudioTranscription: {languageCode: 'en-US'},
          outputAudioTranscription: {languageCode: 'en-US'},
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

    this.currentSessionId = crypto.randomUUID();
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

      const bufferSize = 256;
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

    this.isRecording = false;

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

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private toggleHistoryPanel() {
    this.isHistoryPanelOpen = !this.isHistoryPanelOpen;
    if (this.isHistoryPanelOpen) {
      this.fetchHistory();
    }
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
        <p>Sign in with your Google account to start the conversation.</p>
        <button @click=${this.signInWithGoogle}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24"
            viewBox="0 0 24 24"
            width="24"
            fill="white">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4" />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853" />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
              fill="#FBBC05" />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335" />
            <path d="M1 1h22v22H1z" fill="none" />
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
          <button @click=${this.toggleHistoryPanel}>&times;</button>
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
        <div class="header-controls">
          <button class="history-button" @click=${this.toggleHistoryPanel}>
            History
          </button>
          <button class="logout-button" @click=${this.signOut}>Logout</button>
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