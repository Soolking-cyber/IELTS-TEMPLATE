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

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() private transcripts: Array<{
    speaker: string;
    text: string;
    isFinal?: boolean;
  }> = [];

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
  `;

  constructor() {
    super();
    this.initClient();
  }

  updated(changedProperties: PropertyValues) {
    if (changedProperties.has('transcripts')) {
      const container = this.shadowRoot?.querySelector('.transcripts-container');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
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

  private async initSession() {
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
              if (
                lastTranscript?.speaker === 'Candidate' &&
                !lastTranscript.isFinal
              ) {
                lastTranscript.text += inputTranscription.text;
                lastTranscript.isFinal = (inputTranscription as any).status === 'FINAL';
                this.transcripts = [...this.transcripts];
              } else {
                this.transcripts = [
                  ...this.transcripts,
                  {
                    speaker: 'Candidate',
                    text: inputTranscription.text,
                    isFinal: (inputTranscription as any).status === 'FINAL',
                  },
                ];
              }
            }

            const outputTranscription =
              message.serverContent?.outputTranscription;
            if (outputTranscription?.text) {
              const lastTranscript =
                this.transcripts[this.transcripts.length - 1];
              if (
                lastTranscript?.speaker === 'Examiner' &&
                !lastTranscript.isFinal
              ) {
                lastTranscript.text += outputTranscription.text;
                lastTranscript.isFinal = (outputTranscription as any).status === 'FINAL';
                this.transcripts = [...this.transcripts];
              } else {
                this.transcripts = [
                  ...this.transcripts,
                  {
                    speaker: 'Examiner',
                    text: outputTranscription.text,
                    isFinal: (outputTranscription as any).status === 'FINAL',
                  },
                ];
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
          // FIX: `interruptionConfig` does not exist on type `LiveConnectConfig`. Replaced with `interruptionDelaySeconds`.
          interruptionDelaySeconds: 1.0,
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
        if (!this.isRecording) return;

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

  render() {
    return html`
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
    `;
  }
}
