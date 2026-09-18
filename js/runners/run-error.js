// js/runners/run-error.js — an error whose message is written for you, not for the console.
// Anything thrown as a RunError is printed in the Output tab exactly as it reads here.

export class RunError extends Error {
  /** `action` lets the Run button offer a way out, such as opening Settings. */
  constructor(message, action = null) {
    super(message);
    this.name = 'RunError';
    this.action = action;
  }
}
