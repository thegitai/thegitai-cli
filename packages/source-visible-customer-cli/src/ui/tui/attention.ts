
export type AttentionKind = 'blocked' | 'finished';














export const INITIAL_TERMINAL_FOCUS = true;


export interface AttentionState {

  awaitingAnswer: boolean;
  busy: boolean;






  focused: boolean;
}

export interface AttentionController {
  sync: (state: AttentionState, enabled: boolean) => void;
}













export function createAttentionController(options: {
  notify: (kind: AttentionKind) => void;
  withdraw: () => void;
}): AttentionController {
  let previous: AttentionState | null = null;
  let outstanding = false;

  return {
    sync(state, enabled) {
      const last = previous;



      previous = { ...state };




      if (last && !last.focused && state.focused && outstanding) {
        outstanding = false;
        options.withdraw();
      }



      if (!last || !enabled) return;


      if (state.focused) return;

      const turnFinished = last.busy && !state.busy;
      const nowBlocked = !last.awaitingAnswer && state.awaitingAnswer;



      if (nowBlocked || turnFinished) {
        outstanding = true;
        options.notify(nowBlocked ? 'blocked' : 'finished');
      }
    },
  };
}
