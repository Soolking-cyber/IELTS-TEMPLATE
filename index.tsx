/* tslin:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from '@google/genai';
import {LitElement, css, html, PropertyValues} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import {supabase} from './supabase-client';
import type {Session as SupabaseSession} from '@supabase/supabase-js';

const PART1_INSTRUCTION = `You are an IELTS examiner conducting Part 1 of the speaking test.
Ask the candidate around 11-12 questions on 3 different general topics.
Keep your questions concise. The user is the candidate.
Start the conversation by asking your first question now.`;

const PART2_INSTRUCTION = `You are an IELTS examiner for Part 2 of the speaking test. The candidate will now speak for 1-2 minutes. Your task is to listen silently without speaking or interrupting.`;

const PART3_INSTRUCTION_TEMPLATE = (topic: string) =>
  `You are an IELTS examiner conducting Part 3 of the speaking test.
The topic is a follow-up to Part 2, which was about '${topic}'.
Your role is to ask abstract and opinion-based questions related to this topic.
Keep your questions concise and ask only one question at a time.
Do not provide your own opinions, explanations, or long statements.
After the candidate responds, listen carefully and then ask a relevant follow-up question.
The goal is to simulate a real two-way discussion for 4-5 minutes.
Start the conversation now by asking your first question.`;

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
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
  @state() private sessionFeedback: Record<string, string> = {};

  // View management
  @state() private currentView: 'app' | 'pricing' = 'app';

  // Credit system state
  @state() private userCredits: number | null = null; // Now in seconds
  @state() private isOutOfCreditsModalOpen = false;
  private creditUsageInterval: number | null = null;
  private creditUpdateIntervalMs = 10000; // 10 seconds

  // IELTS specific state
  @state() private currentPart: 'part1' | 'part2' | 'part3' | null = null;
  @state() private part2State:
    | 'idle'
    | 'generating'
    | 'preparing'
    | 'speaking'
    | 'finished' = 'idle';
  @state() private part2CueCard: {
    description: string;
    points: string[];
  } | null = null;
  @state() private part2Topic: string | null = null;
  @state() private part2TopicForPart3: string | null = null; // Persists topic for Part 3
  @state() private part2PreparationTimeLeft = 60;
  @state() private part2SpeakingTimeLeft = 120;
  private part2TimerInterval: number | null = null;

  // Intro Modal State
  @state() private isIntroModalOpen = false;
  @state()
  private introModalContent: {
    title: string;
    instructions: string[];
    checkboxLabel: string;
  } | null = null;
  @state() private isIntroConfirmed = false;

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

    .landing-page {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow-y: auto;
      text-align: center;
    }

    .landing-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 5%;
      width: 90%;
      position: sticky;
      top: 0;
      background-color: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(10px);
      z-index: 10;
    }

    .landing-logo {
      font-size: 1.5rem;
      font-weight: 500;
      color: #fff;
    }

    .google-signin-button {
      background-color: #212121;
      color: #e0e0e0;
      border: 1px solid #444;
      padding: 10px 20px;
      font-size: 0.95rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition:
        background-color 0.3s,
        transform 0.2s;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .google-signin-button:hover {
      background-color: #333;
      transform: translateY(-2px);
    }

    .hero-section {
      padding: 10vh 20px;
    }

    .hero-section h1 {
      font-size: clamp(2.5rem, 5vw, 4rem);
      margin-bottom: 1rem;
      font-weight: 400;
      color: #e0e0e0;
      line-height: 1.2;
    }

    .hero-section p {
      font-size: clamp(1.1rem, 2vw, 1.3rem);
      margin: 0 auto 2.5rem auto;
      color: #aaa;
      max-width: 700px;
      line-height: 1.6;
    }

    .pricing-section {
      padding: 5vh 20px 10vh 20px;
    }

    .pricing-section h2 {
      font-size: clamp(2rem, 4vw, 2.8rem);
      margin-bottom: 4rem;
      font-weight: 400;
      color: #e0e0e0;
    }

    .pricing-container {
      display: flex;
      justify-content: center;
      gap: 30px;
      flex-wrap: wrap;
    }

    .pricing-card {
      background-color: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      align-items: center;
      transition: transform 0.3s, border-color 0.3s;
    }

    .pricing-card:hover {
      transform: translateY(-5px);
    }

    .pricing-card.highlight {
      border-color: #4285f4;
      transform: scale(1.05);
    }

    .pricing-title-container {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 1rem;
    }

    .discount-badge {
      background-color: #34a853; /* Google Green */
      color: #fff;
      padding: 4px 10px;
      border-radius: 16px; /* Pill shape */
      font-size: 0.7rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .pricing-title {
      font-size: 1.5rem;
      font-weight: 500;
      margin-bottom: 0; /* Moved to container */
    }

    .pricing-price {
      font-size: 3rem;
      font-weight: bold;
      margin-bottom: 1.5rem;
    }

    .pricing-features {
      list-style: none;
      padding: 0;
      margin: 0 0 2rem 0;
      text-align: center;
      width: 100%;
    }

    .pricing-features li {
      color: #bbb;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #333;
    }
    .pricing-features li:last-child {
      border-bottom: none;
      margin-bottom: 0;
    }

    .pricing-button {
      background-color: #4285f4;
      color: #fff;
      border: none;
      padding: 14px 28px;
      font-size: 1rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
      transition: background-color 0.3s;
    }

    .pricing-button:hover {
      background-color: #357ae8;
    }

    .pricing-card:not(.highlight) .pricing-button {
      background-color: #333;
    }

    .pricing-card:not(.highlight) .pricing-button:hover {
      background-color: #444;
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
      width: 220px;
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

    .dropdown-item-static {
      padding: 12px 16px;
      color: #bbb;
      font-size: 0.9rem;
      border-bottom: 1px solid #444;
    }

    .app-container {
      display: flex;
      flex-direction: column; /* Vertical layout for all screens */
      width: 100%;
      height: 100%;
      position: relative;
    }

    .part-selector {
      display: flex;
      margin: 10px 10px 0 10px;
      margin-bottom: -1px; /* Overlap border */
    }

    .part-button {
      flex: 1;
      background-color: #282828;
      color: #aaa;
      border: 1px solid #333;
      border-bottom: none;
      padding: 12px 20px;
      font-size: 1rem;
      font-weight: 500;
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      transition: background-color 0.3s, color 0.3s;
    }

    .part-button:hover:not(.active) {
      background-color: #3a3a3a;
      color: #fff;
    }

    .part-button.active {
      background-color: #121212;
      color: white;
      position: relative;
      z-index: 1;
    }

    .part-button:disabled {
      background-color: #222;
      color: #666;
      border-color: #333;
      cursor: not-allowed;
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
      margin: 0 10px 10px 10px;
      border-radius: 0 0 12px 12px;
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

    .cue-card-container {
      padding: 15px;
      margin-bottom: 15px;
      background-color: #242424;
      border: 1px solid #444;
      border-radius: 8px;
      align-self: center;
      max-width: 90%;
      width: 500px;
    }

    .cue-card h4 {
      margin-top: 0;
      color: #c0c0c0;
      text-align: center;
      border-bottom: 1px solid #444;
      padding-bottom: 10px;
      margin-bottom: 10px;
    }

    .cue-card p {
      margin: 0;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .cue-card-description {
      margin-bottom: 15px;
    }

    .cue-card-points {
      list-style-type: none;
      padding-left: 0;
      margin: 0;
      text-align: left;
    }

    .cue-card-points li {
      position: relative;
      padding-left: 1.5em; /* Space for the bullet */
      margin-bottom: 0.8em;
      line-height: 1.5;
    }

    .cue-card-points li::before {
      content: '•';
      position: absolute;
      left: 0;
      font-size: 1.2em;
      line-height: 1;
      color: #c0c0c0;
    }

    .timer {
      text-align: center;
      font-size: 1.2rem;
      font-weight: bold;
      color: #ef4444;
      margin-top: 15px;
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

    .feedback-section {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #444;
    }

    .feedback-section h4 {
      margin: 0 0 8px 0;
      color: #c0c0c0;
      font-size: 0.9rem;
      font-weight: bold;
    }

    .feedback-section p {
      margin: 0;
      font-size: 0.9rem;
      line-height: 1.5;
      color: #e0e0e0;
      font-style: italic;
    }

    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background-color: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background-color: #282828;
      padding: 30px 40px;
      border-radius: 12px;
      text-align: center;
      border: 1px solid #444;
      box-shadow: 0 5px 20px rgba(0, 0, 0, 0.5);
      max-width: 400px;
      width: 90%;
    }

    .modal-content.intro-modal {
      text-align: left;
      max-width: 500px;
    }

    .intro-modal h2 {
      text-align: center;
      border-bottom: 1px solid #444;
      padding-bottom: 15px;
      margin-bottom: 20px;
    }

    .intro-modal ul {
      list-style-type: none;
      padding: 0;
      margin: 0 0 25px 0;
    }

    .intro-modal li {
      padding: 10px 0;
      border-bottom: 1px solid #333;
      line-height: 1.5;
    }

    .intro-modal li:last-child {
      border-bottom: none;
    }

    .intro-modal li::before {
      content: '✓';
      color: #4285f4;
      font-weight: bold;
      display: inline-block;
      width: 1em;
      margin-left: -1em;
    }

    .confirmation-container {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 25px;
      justify-content: center;
    }

    .confirmation-container input[type='checkbox'] {
      width: 18px;
      height: 18px;
      accent-color: #4285f4;
    }

    .confirmation-container label {
      font-size: 0.95rem;
      color: #ddd;
    }

    .modal-content h2 {
      margin-top: 0;
      color: #e0e0e0;
      font-size: 1.5rem;
    }

    .modal-content p {
      color: #bbb;
      margin-bottom: 25px;
      line-height: 1.6;
    }

    .modal-button {
      background-color: #4285f4;
      color: #fff;
      border: none;
      padding: 12px 24px;
      font-size: 1rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.3s;
      width: 100%;
    }

    .modal-button:hover:not(:disabled) {
      background-color: #357ae8;
    }

    .modal-button:disabled {
      background-color: #444;
      color: #888;
      cursor: not-allowed;
    }

    /* Tablet and Desktop Styles */
    @media (min-width: 768px) {
      .part-selector {
        margin: 20px auto 0 auto;
        width: 90%;
        max-width: 800px;
      }

      /* On desktop, keep the column layout but center the transcript box */
      .transcripts-container {
        margin: 0 auto 20px auto; /* Center horizontally, add vertical margin */
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
    if (this.part2TimerInterval) {
      clearInterval(this.part2TimerInterval);
    }
    if (this.creditUsageInterval) {
      clearInterval(this.creditUsageInterval);
    }
  }

  updated(changedProperties: PropertyValues) {
    if (changedProperties.has('transcripts')) {
      const container = this.shadowRoot?.querySelector('.transcripts-container');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }

    if (changedProperties.has('supabaseSession')) {
      const oldSession = changedProperties.get('supabaseSession') as
        | SupabaseSession
        | null
        | undefined;
      // User just logged in
      if (this.supabaseSession && !oldSession) {
        if (!this.client) {
          this.initClient();
        }
        this.fetchUserProfile();
        this.fetchHistory();
        this.currentView = 'app';
      }
      // User just logged out
      else if (!this.supabaseSession && oldSession) {
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
    this.sessionFeedback = {};
    this.isHistoryPanelOpen = false;
    this.userCredits = null;
    this.currentView = 'app';
    if (this.creditUsageInterval) {
      clearInterval(this.creditUsageInterval);
      this.creditUsageInterval = null;
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
  }

  private async saveCurrentSessionHistory() {
    if (
      !this.supabaseSession ||
      !this.currentSessionId ||
      this.transcripts.length === 0
    ) {
      return;
    }

    const transcriptsToSave = this.transcripts.map(({speaker, text}) => ({
      user_id: this.supabaseSession!.user.id,
      session_id: this.currentSessionId!,
      speaker,
      text,
    }));

    const {data, error} = await supabase
      .from('transcripts')
      .insert(transcriptsToSave)
      .select('session_id, speaker, text, created_at');

    if (error) {
      console.error('Error saving session history:', error.message);
    } else if (data) {
      this.chatHistory = {
        ...this.chatHistory,
        [this.currentSessionId!]: data,
      };
    }
  }

  private async processMissingFeedback() {
    if (!this.client || !this.supabaseSession) {
      return;
    }

    await this.fetchHistory();

    const sessionIdsWithHistory = Object.keys(this.chatHistory);
    const sessionIdsWithFeedback = Object.keys(this.sessionFeedback);

    const sessionsToProcess = sessionIdsWithHistory.filter(
      (id) => !sessionIdsWithFeedback.includes(id),
    );

    if (sessionsToProcess.length === 0) {
      console.log('No sessions are missing feedback.');
      return;
    }

    console.log(
      `Found ${sessionsToProcess.length} sessions to process for feedback.`,
    );

    for (const sessionId of sessionsToProcess) {
      const sessionTranscripts = this.chatHistory[sessionId];
      if (!sessionTranscripts || sessionTranscripts.length === 0) {
        continue;
      }

      const candidateTranscripts = sessionTranscripts
        .filter((t) => t.speaker === 'Candidate')
        .map((t) => t.text)
        .join(' ');

      if (!candidateTranscripts.trim()) {
        console.log(`No candidate speech to analyze for session ${sessionId}.`);
        continue;
      }

      let feedbackText = '';
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const prompt = `Analyze the following IELTS candidate's speech. Provide one sentence of feedback that includes two relevant, advanced vocabulary words the candidate could use to improve their answer. Enclose the vocabulary words in double asterisks for emphasis (e.g., **word**). The feedback must be a single, concise sentence directly related to their speech. Here is the transcript: "${candidateTranscripts}"`;

          const response = await this.client.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
          });

          feedbackText = response.text;
          break; // Success
        } catch (e) {
          console.error(
            `Attempt ${attempt} failed to generate feedback for session ${sessionId}:`,
            e,
          );
          if (attempt === maxRetries) {
            console.error(`All attempts failed for session ${sessionId}.`);
          } else {
            const delay = Math.pow(2, attempt - 1) * 1000;
            console.log(`Retrying in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!feedbackText) {
        continue;
      }

      try {
        const {error} = await supabase.from('session_feedback').insert({
          session_id: sessionId,
          user_id: this.supabaseSession.user.id,
          feedback: feedbackText,
        });

        if (error) {
          console.error(
            `Error saving feedback for session ${sessionId}:`,
            error.message,
          );
        } else {
          console.log(
            `Successfully generated and saved feedback for session ${sessionId}.`,
          );
          this.sessionFeedback = {
            ...this.sessionFeedback,
            [sessionId]: feedbackText,
          };
        }
      } catch (e) {
        console.error(
          `Error saving feedback to DB for session ${sessionId}:`,
          e,
        );
      }
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

    const {data: feedbackData, error: feedbackError} = await supabase
      .from('session_feedback')
      .select('session_id, feedback')
      .eq('user_id', this.supabaseSession.user.id);

    if (feedbackError) {
      console.error('Error fetching feedback:', feedbackError.message);
    } else if (feedbackData) {
      const feedbackMap = feedbackData.reduce((acc, item) => {
        acc[item.session_id] = item.feedback;
        return acc;
      }, {});
      this.sessionFeedback = feedbackMap;
    }
  }

  private async initSession(
    systemInstruction: string,
    responseModalities: Modality[] = [Modality.AUDIO],
  ) {
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
          responseModalities: responseModalities,
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
          inputAudioTranscription: {
            languageCodes: ['en-US'],
            model: 'chirp',
            // Increased to allow for longer pauses during monologues (e.g. Part 2)
            endOfSpeechTimeoutMillis: 5000,
          },
          outputAudioTranscription: {languageCodes: ['en-US']},
          systemInstruction,
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private async startRecording(
    systemInstruction: string,
    responseModalities: Modality[] = [Modality.AUDIO],
  ) {
    if (this.userCredits !== null && this.userCredits <= 0) {
      this.isOutOfCreditsModalOpen = true;
      return;
    }
    if (this.isRecording) {
      return;
    }

    this.transcripts = [];
    this.currentSessionId = crypto.randomUUID();

    await this.initSession(systemInstruction, responseModalities);
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
      this.creditUsageInterval = window.setInterval(
        () => this.deductCredits(),
        this.creditUpdateIntervalMs,
      );
    } catch (err) {
      console.error('Error starting recording:', err);
      this.stopRecording();
    }
  }

  private async stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    if (this.currentPart === 'part2' && this.part2Topic) {
      this.part2TopicForPart3 = this.part2Topic;
      this.part2State = 'finished';
    }

    if (this.part2TimerInterval) {
      clearInterval(this.part2TimerInterval);
      this.part2TimerInterval = null;
    }

    if (this.creditUsageInterval) {
      clearInterval(this.creditUsageInterval);
      this.creditUsageInterval = null;
    }

    if (this.transcripts.length > 0) {
      await this.saveCurrentSessionHistory();
      this.processMissingFeedback();
    }

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

  private async stopCurrentSession() {
    if (this.isRecording) {
      await this.stopRecording();
    }
  }

  private async handlePartSelect(part: 'part1' | 'part2' | 'part3') {
    await this.stopCurrentSession();

    if (this.userCredits !== null && this.userCredits <= 0) {
      this.isOutOfCreditsModalOpen = true;
      return;
    }

    this.currentPart = part;
    this.transcripts = [];
    this.part2CueCard = null;
    this.part2Topic = null;
    this.part2State = 'idle';
    this.part2PreparationTimeLeft = 60;
    this.part2SpeakingTimeLeft = 120;

    switch (part) {
      case 'part1':
        this.introModalContent = {
          title: 'IELTS Speaking: Part 1',
          instructions: [
            'You will be asked general questions about yourself and familiar topics.',
            'This part lasts for 4-5 minutes.',
            'Ensure you are in a quiet place with a working microphone.',
          ],
          checkboxLabel: 'I understand and am ready to begin.',
        };
        break;
      case 'part2':
        this.introModalContent = {
          title: 'IELTS Speaking: Part 2',
          instructions: [
            'You will be given a cue card with a topic.',
            'You will have 1 minute to prepare and take notes.',
            'You must speak on the topic for 1-2 minutes.',
            'Please have a pen and paper ready for note-taking.',
          ],
          checkboxLabel: 'I have my pen and paper, and I am ready.',
        };
        break;
      case 'part3':
        if (!this.part2TopicForPart3) {
          this.transcripts = [
            {
              speaker: 'Examiner',
              text: 'Please complete Part 2 before starting Part 3.',
            },
          ];
          return;
        }
        this.introModalContent = {
          title: 'IELTS Speaking: Part 3',
          instructions: [
            'You will be asked abstract questions related to the topic from Part 2.',
            'This is a two-way discussion with the examiner.',
            'This part lasts for 4-5 minutes.',
          ],
          checkboxLabel: 'I understand and am ready to continue.',
        };
        break;
    }

    this.isIntroConfirmed = false;
    this.isIntroModalOpen = true;
  }

  private async handleStartPart() {
    this.isIntroModalOpen = false;
    if (!this.currentPart) return;

    if (this.currentPart === 'part1') {
      await this.startRecording(PART1_INSTRUCTION);
    } else if (this.currentPart === 'part2') {
      this.part2State = 'generating';
      this.transcripts = [
        {speaker: 'Examiner', text: 'Generating your Part 2 cue card...'},
      ];
      await this.generateCueCard();
    } else if (this.currentPart === 'part3') {
      if (this.part2TopicForPart3) {
        await this.startRecording(
          PART3_INSTRUCTION_TEMPLATE(this.part2TopicForPart3),
        );
      }
    }
  }

  private async generateCueCard() {
    try {
      const prompt = `Generate a random IELTS Speaking Part 2 cue card. The response should be a JSON object with three keys: 'topic' (a short string for the general theme, e.g., 'A memorable trip'), 'description' (the main introductory text for the cue card), and 'points' (an array of 3-4 strings, each being a bullet point for what the candidate should talk about).`;

      const response = await this.client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              topic: {type: Type.STRING},
              description: {type: Type.STRING},
              points: {
                type: Type.ARRAY,
                items: {
                  type: Type.STRING,
                },
              },
            },
          },
        },
      });

      const jsonString = response.text;
      const result = JSON.parse(jsonString);

      this.part2Topic = result.topic;
      this.part2CueCard = {
        description: result.description,
        points: result.points,
      };
      this.transcripts = []; // Clear the "generating" message
      this.startPart2Preparation();
    } catch (e) {
      console.error('Error generating cue card:', e);
      this.transcripts = [
        {
          speaker: 'Examiner',
          text: 'Sorry, there was an error generating the cue card. Please try again.',
        },
      ];
      this.part2State = 'idle';
    }
  }

  private startPart2Preparation() {
    this.part2State = 'preparing';
    this.part2PreparationTimeLeft = 60;

    this.part2TimerInterval = window.setInterval(() => {
      this.part2PreparationTimeLeft -= 1;
      if (this.part2PreparationTimeLeft <= 0) {
        clearInterval(this.part2TimerInterval!);
        this.part2TimerInterval = null;
        this.startPart2SpeakingSession();
      }
    }, 1000);
  }

  private async startPart2SpeakingSession() {
    this.part2State = 'speaking';
    this.part2SpeakingTimeLeft = 120;

    // The model is instructed to be silent. We request AUDIO modality to ensure
    // the connection remains active and provides input transcriptions.
    // With TEXT modality, no transcription was being returned during Part 2.
    await this.startRecording(PART2_INSTRUCTION, [Modality.AUDIO]);

    this.part2TimerInterval = window.setInterval(() => {
      this.part2SpeakingTimeLeft -= 1;
      if (this.part2SpeakingTimeLeft <= 0) {
        clearInterval(this.part2TimerInterval!);
        this.part2TimerInterval = null;
        this.stopCurrentSession(); // Automatically stop the session
      }
    }, 1000);
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

  private async fetchUserProfile() {
    if (!this.supabaseSession) return;

    const {data, error} = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', this.supabaseSession.user.id)
      .single();

    if (error) {
      console.error('Error fetching user profile:', error.message);
    } else if (data) {
      this.userCredits = data.credits;
    }
  }

  private async deductCredits() {
    if (!this.isRecording || this.userCredits === null) return;

    const secondsToDeduct = this.creditUpdateIntervalMs / 1000;

    const {data, error} = await supabase.rpc('deduct_credits', {
      seconds_to_deduct: secondsToDeduct,
    });

    if (error) {
      console.error('Error deducting credits:', error);
      // Optional: Stop the session if deduction fails to prevent misuse.
      // await this.stopCurrentSession();
      return;
    }

    this.userCredits = data;

    if (this.userCredits <= 0) {
      await this.stopCurrentSession();
      this.isOutOfCreditsModalOpen = true;
    }
  }

  private async handleSubscription(planId: string) {
    if (!this.supabaseSession) {
      // If user is not signed in, prompt them to sign in first.
      // A more robust solution would store the desired plan and redirect
      // after sign-in, but for simplicity, the user can click again.
      await this.signInWithGoogle();
      return;
    }

    // In a real application, you would generate a unique checkout session on your
    // backend and include the user's ID. For this demo, we use static placeholder
    // links. After purchase, Stripe webhooks would update the user's credits
    // and subscription status in your Supabase database.
    const paymentLinks: Record<string, string> = {
      starter: 'https://buy.stripe.com/test_5kA8A75Ie5pS1i0dQQ',
      pro: 'https://buy.stripe.com/test_7sI1nZg4Q5pS0e4cMN',
    };

    const url = paymentLinks[planId];
    if (url) {
      window.location.href = url;
    } else {
      console.error('Invalid plan ID:', planId);
      alert('Could not process the selected plan. Please try again.');
    }
  }

  private redirectToPricing() {
    this.isOutOfCreditsModalOpen = false;
    this.currentView = 'pricing';
  }

  private async handleVisualizerClick() {
    if (this.isRecording) {
      await this.stopRecording();
    } else if (this.currentPart) {
      // If a part is selected but not running, start it.
      // Re-calling handlePartSelect is the correct way to trigger
      // the start/restart logic for that part.
      await this.handlePartSelect(this.currentPart);
    }
    // If no part is selected, do nothing. The user must use the part buttons.
  }

  private renderOutOfCreditsModal() {
    return html`
      <div class="modal-overlay">
        <div class="modal-content">
          <h2>Out of Credits</h2>
          <p>
            You have used all your practice credits for this month. Please
            upgrade your plan or wait for your credits to reset next month.
          </p>
          <button class="modal-button" @click=${this.redirectToPricing}>
            View Plans
          </button>
        </div>
      </div>
    `;
  }

  private renderIntroModal() {
    if (!this.isIntroModalOpen || !this.introModalContent) return '';
    return html`
      <div class="modal-overlay">
        <div class="modal-content intro-modal">
          <h2>${this.introModalContent.title}</h2>
          <ul>
            ${this.introModalContent.instructions.map(
              (i) => html`<li>${i}</li>`,
            )}
          </ul>
          <div class="confirmation-container">
            <input
              type="checkbox"
              id="intro-confirm"
              .checked=${this.isIntroConfirmed}
              @change=${(e: Event) =>
                (this.isIntroConfirmed = (e.target as HTMLInputElement).checked)} />
            <label for="intro-confirm"
              >${this.introModalContent.checkboxLabel}</label
            >
          </div>
          <button
            class="modal-button"
            ?disabled=${!this.isIntroConfirmed}
            @click=${this.handleStartPart}>
            Start
          </button>
        </div>
      </div>
    `;
  }

  private renderPricingCard(
    title: string,
    price: string,
    features: string[],
    planId: 'free' | 'starter' | 'pro',
    highlight: boolean,
    discount?: string,
  ) {
    return html`
      <div class="pricing-card ${highlight ? 'highlight' : ''}">
        ${discount
          ? html`
              <div class="pricing-title-container">
                <h3 class="pricing-title">${title}</h3>
                <span class="discount-badge">${discount}</span>
              </div>
            `
          : html` <h3 class="pricing-title">${title}</h3> `}
        <p class="pricing-price">${price}</p>
        <ul class="pricing-features">
          ${features.map((f) => html`<li>${f}</li>`)}
        </ul>
        <button
          class="pricing-button"
          @click=${() =>
            planId === 'free'
              ? this.signInWithGoogle()
              : this.handleSubscription(planId)}>
          ${planId === 'free' ? 'Get Started' : 'Choose Plan'}
        </button>
      </div>
    `;
  }

  private renderLogin() {
    return html`
      <div class="landing-page">
        <header class="landing-header">
          <div class="landing-logo">AI IELTS Examiner</div>
          <button class="google-signin-button" @click=${this.signInWithGoogle}>
            <svg
              height="24"
              width="24"
              viewBox="0 0 24 24"
              fill="currentColor">
              <path
                d="M21.35,11.1H12.18V13.83H18.69C18.36,17.64 15.19,19.27 12.19,19.27C8.36,19.27 5,16.25 5,12C5,7.9 8.2,4.73 12.19,4.73C15.29,4.73 17.1,6.7 17.1,6.7L19,4.72C19,4.72 16.56,2 12.19,2C6.42,2 2.03,6.8 2.03,12C2.03,17.05 6.16,22 12.19,22C17.6,22 21.5,18.33 21.5,12.91C21.5,11.76 21.35,11.1 21.35,11.1V11.1Z"></path>
            </svg>
            Sign In With Google
          </button>
        </header>
        <main>
          <section class="hero-section">
            <h1>Ace Your IELTS Speaking Test</h1>
            <p>
              Practice with a realistic AI examiner, get instant feedback, and
              build your confidence for test day.
            </p>
          </section>
          <section class="pricing-section">
            <h2>Simple, Monthly Subscriptions</h2>
            <div class="pricing-container">
              ${this.renderPricingCard(
                'Free',
                '$0',
                ['5 Minutes of Practice', 'Standard AI Examiner', 'Basic Feedback'],
                'free',
                false,
              )}
              ${this.renderPricingCard(
                'Starter',
                '$9 / mo',
                [
                  '100 Minutes / Month',
                  'Credits reset monthly',
                  'Detailed Feedback & History',
                ],
                'starter',
                false,
              )}
              ${this.renderPricingCard(
                'Pro',
                '$19 / mo',
                [
                  '300 Minutes / Month',
                  'Credits reset monthly',
                  'Detailed Feedback & History',
                ],
                'pro',
                true,
                'SAVE 30%',
              )}
            </div>
          </section>
        </main>
      </div>
    `;
  }

  private renderPricingPage() {
    return html`
      <div class="landing-page">
        <header class="landing-header">
          <div class="landing-logo">AI IELTS Examiner</div>
          <button
            class="google-signin-button"
            @click=${() => (this.currentView = 'app')}>
            Back to Practice
          </button>
        </header>
        <main>
          <section class="pricing-section" style="padding-top: 5vh;">
            <h2>Upgrade Your Plan</h2>
            <div class="pricing-container">
              ${this.renderPricingCard(
                'Starter',
                '$9 / mo',
                [
                  '100 Minutes / Month',
                  'Credits reset monthly',
                  'Detailed Feedback & History',
                ],
                'starter',
                false,
              )}
              ${this.renderPricingCard(
                'Pro',
                '$19 / mo',
                [
                  '300 Minutes / Month',
                  'Credits reset monthly',
                  'Detailed Feedback & History',
                ],
                'pro',
                true,
                'SAVE 30%',
              )}
            </div>
          </section>
        </main>
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
                    ${this.sessionFeedback[sessionId]
                      ? html`
                          <div class="feedback-section">
                            <h4>Feedback</h4>
                            <p>${this.sessionFeedback[sessionId]}</p>
                          </div>
                        `
                      : ''}
                  </div>
                `,
              )}
        </div>
      </div>
    `;
  }

  private renderIeltsContent() {
    return html`
      ${this.currentPart === 'part2' &&
      (this.part2State === 'preparing' || this.part2State === 'speaking')
        ? html`
            <div class="cue-card-container">
              ${this.part2State === 'preparing' && this.part2CueCard
                ? html`
                    <div class="cue-card">
                      <h4>IELTS Speaking Part 2</h4>
                      <p class="cue-card-description">
                        ${this.part2CueCard.description}
                      </p>
                      <ul class="cue-card-points">
                        ${this.part2CueCard.points.map(
                          (point) => html`<li>${point}</li>`,
                        )}
                      </ul>
                    </div>
                  `
                : ''}
              ${this.part2State === 'speaking' && !this.part2CueCard
                ? ''
                : html`
                    ${this.part2State === 'preparing'
                      ? html`<div class="timer">
                          Prepare: ${this.part2PreparationTimeLeft}s
                        </div>`
                      : ''}
                    ${this.part2State === 'speaking'
                      ? html`<div class="timer">
                          Speak:
                          ${Math.floor(this.part2SpeakingTimeLeft / 60)}:${(
                              this.part2SpeakingTimeLeft % 60
                            )
                              .toString()
                              .padStart(2, '0')}
                        </div>`
                      : ''}
                  `}
            </div>
          `
        : ''}
      ${this.transcripts.map(
        (t) => html`
          <div class="transcript-line ${t.speaker.toLowerCase()}">
            <strong>${t.speaker}</strong>
            <div>${t.text}</div>
          </div>
        `,
      )}
    `;
  }

  private renderApp() {
    return html`
      <div class="app-container">
        ${this.isOutOfCreditsModalOpen ? this.renderOutOfCreditsModal() : ''}
        ${this.isIntroModalOpen ? this.renderIntroModal() : ''}

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
            <div class="dropdown-item-static">
              Monthly Time Left:
              ${this.userCredits !== null
                ? `${Math.floor(this.userCredits / 60)} min`
                : '...'}
            </div>
            <button class="dropdown-item" @click=${this.openHistoryPanel}>
              History
            </button>
            <button
              class="dropdown-item"
              @click=${() =>
                (window.location.href =
                  'https://billing.stripe.com/p/login/test_7sI5nRb3C2hGeD6eUU')}>
              Manage Subscription
            </button>
            <button class="dropdown-item" @click=${this.signOut}>Logout</button>
          </div>
        </div>

        ${this.renderHistoryPanel()}

        <div class="visualizer-container">
          <gdm-audio-visualizer
            @visualizer-click=${this.handleVisualizerClick}
            .inputNode=${this.inputNode}
            .outputNode=${this.outputNode}
            .isRecording=${this.isRecording}></gdm-audio-visualizer>
        </div>
        <div class="part-selector">
          <button
            class="part-button ${this.currentPart === 'part1' ? 'active' : ''}"
            ?disabled=${this.isRecording && this.currentPart !== 'part1'}
            @click=${() => this.handlePartSelect('part1')}>
            Part 1
          </button>
          <button
            class="part-button ${this.currentPart === 'part2' ? 'active' : ''}"
            ?disabled=${this.isRecording && this.currentPart !== 'part2'}
            @click=${() => this.handlePartSelect('part2')}>
            Part 2
          </button>
          <button
            class="part-button ${this.currentPart === 'part3' ? 'active' : ''}"
            ?disabled=${this.isRecording && this.currentPart !== 'part3'}
            @click=${() => this.handlePartSelect('part3')}>
            Part 3
          </button>
        </div>
        <div class="transcripts-container">${this.renderIeltsContent()}</div>
      </div>
    `;
  }

  render() {
    if (!this.supabaseSession) {
      return this.renderLogin();
    }
    if (this.currentView === 'pricing') {
      return this.renderPricingPage();
    }
    return this.renderApp();
  }
}