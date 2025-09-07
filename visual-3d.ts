/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

/**
 * Audio visualizer circle.
 */
@customElement('gdm-audio-visualizer')
export class GdmAudioVisualizer extends LitElement {
  @property({type: Object}) inputNode!: AudioNode;
  @property({type: Object}) outputNode!: AudioNode;
  @property({type: Boolean}) isRecording = false;

  private canvas!: HTMLCanvasElement;
  private canvasCtx!: CanvasRenderingContext2D;
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;

  static styles = css`
    :host {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      height: 100%;
      cursor: pointer;
      background-color: #000;
    }
    canvas {
      width: 400px;
      height: 400px;
      max-width: 90vmin;
      max-height: 90vmin;
    }
  `;

  firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.canvasCtx = this.canvas.getContext('2d')!;
    this.canvas.width = 400; // Use higher resolution for crisp drawing
    this.canvas.height = 400;

    if (this.inputNode && this.outputNode) {
      this.setupAnalysers();
      this.draw();
    }
  }

  willUpdate(changedProperties: Map<string, unknown>) {
    // Initialize analysers when nodes are available
    if (
      changedProperties.has('inputNode') ||
      changedProperties.has('outputNode')
    ) {
      if (this.inputNode && this.outputNode) {
        this.setupAnalysers();
        if (this.canvasCtx) {
          this.draw();
        }
      }
    }
  }

  private setupAnalysers() {
    this.inputAnalyser = new Analyser(this.inputNode);
    this.outputAnalyser = new Analyser(this.outputNode);
  }

  private draw() {
    if (!this.canvasCtx || !this.inputAnalyser || !this.outputAnalyser) {
      requestAnimationFrame(() => this.draw());
      return;
    }

    this.inputAnalyser.update();
    this.outputAnalyser.update();

    const WIDTH = this.canvas.width;
    const HEIGHT = this.canvas.height;
    this.canvasCtx.clearRect(0, 0, WIDTH, HEIGHT);

    let inputSum = 0;
    for (const value of this.inputAnalyser.data) {
      inputSum += value;
    }
    const inputAvg = inputSum / this.inputAnalyser.data.length || 0;

    let outputSum = 0;
    for (const value of this.outputAnalyser.data) {
      outputSum += value;
    }
    const outputAvg = outputSum / this.outputAnalyser.data.length || 0;

    const overallAvg = (inputAvg + outputAvg) / 2;
    const baseRadius = 160;
    const pulse = (overallAvg / 255) * 100; // Scale the pulse effect
    const radius = Math.min(baseRadius + pulse, WIDTH / 2 - 2); // Prevent overflow

    this.canvasCtx.beginPath();
    this.canvasCtx.arc(WIDTH / 2, HEIGHT / 2, radius, 0, 2 * Math.PI);

    if (this.isRecording) {
      this.canvasCtx.fillStyle = 'white';
      this.canvasCtx.fill();
    } else {
      this.canvasCtx.strokeStyle = 'white';
      this.canvasCtx.lineWidth = 2;
      this.canvasCtx.stroke();
    }

    requestAnimationFrame(() => this.draw());
  }

  render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-audio-visualizer': GdmAudioVisualizer;
  }
}