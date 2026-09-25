import { excerpt } from './context.js';

const MAX_PROMPT_CHARS = 32_000;

export function buildAssistSystemPrompt({ recap, suggestion }) {
  return [
    `Return exactly one JSON object with string fields: ${[recap ? '"recap"' : '', suggestion ? '"suggestion"' : ''].filter(Boolean).join(', ')}.`,
    recap ? 'recap is a reminder of the actual work accomplished or conclusion reached in the recent conversation. In at most 20 words, name the concrete behavior or subject and its current result. The reader wants to remember WHAT changed or was learned.' : '',
    recap ? 'Write the recap for the person using the app, not for someone reviewing its code. Name the feature and the concrete difference the user will notice. Replace generic "implemented and tested" summaries with what now works differently or what was learned. File paths, internal module names, test counts, and lists of checks belong in the recap only when they are the subject of the user\'s request. Preserve a specific finding or limitation when it changes the meaning of the result.' : '',
    recap ? 'For a closing exchange such as a commit, push, acknowledgment, or thank-you, summarize the substantive work from the preceding answers. Commit bookkeeping, authorship, branch names, and hashes are secondary and usually omitted. A recap saying only that optimizations or changes were committed does not serve this purpose.' : '',
    recap ? 'Use the latest state of that work. Distinguish recommendations from actions already performed, and implementations from verified deployments. Retain the reported conclusion without recalculating detailed lists. Earlier unrelated topics are not part of the recap.' : '',
    suggestion ? 'suggestion predicts the next message this user would naturally type. Use their recent messages, original request, and the latest reply to predict their intent rather than recommend what you think they should do. It should feel like something they were already about to type.' : '',
    suggestion ? 'Task completion does not rule out a suggestion. A natural next step can be testing the change, trying it, committing or pushing finished work, accepting an offered next step, or choosing an option when their preference is clear from the conversation. A suggestion only fills the input for the user to review; it does not authorize or execute that action.' : '',
    suggestion ? 'Examples: after fixing a bug when the user requested tests, suggest "run the tests"; after writing code, "try it out"; after finished work with an obvious commit step, "commit this"; when asked whether to proceed, "go ahead". Prefer the concrete next action over a generic continuation.' : '',
    suggestion ? 'Return "" when the likely next input is unclear, the user needs to assess an error or misunderstanding, or a prediction would involve sensitive or potentially unsafe actions. Do not invent a new topic, feature, or preference.' : '',
    suggestion ? 'Write only the proposed input in suggestion, in the user\'s voice and style. Use one brief sentence, normally 2-12 words or an equally short phrase in languages without word spaces, under 100 characters. A natural short confirmation is allowed. Omit labels, quotes, Markdown, explanations, praise, thanks, questions, and assistant-voice offers such as "I will" or "Let me".' : '',
    'Language: all requested fields follow the latest user-authored communication, including the user\'s comments on quotes. Ignore the language of the quoted material, code, logs, assistant responses, and these instructions. For a language-neutral acknowledgment use recent user-authored communication. Keep technical names unchanged where useful.',
    recap && suggestion ? 'Keep recap and suggestion independent: recap recalls recent work, while suggestion predicts the user\'s next message in the current conversation. A completed recap can accompany a useful follow-up; an empty suggestion can accompany a useful recap.' : '',
  ].filter(Boolean).join('\n');
}

function renderTurn(turn, index, userText = turn.user.text, answerText = turn.assistant?.text ?? '') {
  return [
    `Turn ${index + 1}${turn.complete ? '' : ' (interrupted before a final response)'}`,
    'User message with attached context:', userText,
    turn.complete ? 'Assistant final response:' : 'Assistant progress before interruption:', answerText,
  ].join('\n');
}

export function buildAssistPrompt(turns, targets, charBudget) {
  const budget = Math.min(MAX_PROMPT_CHARS, Math.floor(charBudget));
  if (!Number.isFinite(budget) || budget < 1_000 || !turns.length) return null;
  const languageBudget = Math.min(3_600, Math.floor(budget / 5));
  const language = excerpt(turns.map((turn) => excerpt(turn.user.authored, 1_200)).filter(Boolean).join('\n'), languageBudget);
  const header = 'Recent conversation turns, oldest first. Older turns may be omitted.\n\n';
  const requested = [targets.recap ? 'a reminder of the recent substantive work in recap' : '', targets.suggestion ? 'the user\'s likely next input in suggestion, or an empty string when none is clear' : ''].filter(Boolean).join(', and ');
  const footer = `\n\n--- End of conversation evidence ---\n\nRecent user-authored communication, excluding attached quotes, oldest first:\n\n${language}\n\nReturn ${requested}.`;
  const available = budget - header.length - footer.length;
  const kept = turns.slice();
  let body = kept.map((turn, i) => renderTurn(turn, i)).join('\n\n---\n\n');
  while (body.length > available && kept.length > 1) {
    kept.shift();
    body = kept.map((turn, i) => renderTurn(turn, i)).join('\n\n---\n\n');
  }
  if (body.length > available) {
    const turn = kept[0];
    const textBudget = available - renderTurn(turn, 0, '', '').length;
    if (textBudget < 128) return null;
    const answer = turn.assistant?.text ?? '';
    const userBudget = Math.min(turn.user.text.length, Math.max(Math.floor(textBudget / 3), textBudget - answer.length));
    body = renderTurn(turn, 0, excerpt(turn.user.text, userBudget), excerpt(answer, textBudget - userBudget));
  }
  return { text: header + body + footer, language };
}
