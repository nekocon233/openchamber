import type { AgentMentionInfo } from '../types';
import { buildAgentHref, buildSkillHref } from '@/lib/messages/inlineMessageLinks';

export const SKILL_TOKEN_PATTERN = /(^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const escapeHtml = (text: string): string => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
};

// A code span on one line, fenced by the same run of backticks on both sides.
// Markdown shows its text literally and escapes it itself, so an entity written
// here would print as `&amp;`. Spans are kept to one line so a stray backtick
// cannot leave the rest of a paragraph unescaped.
const INLINE_CODE_PATTERN = /(?<!`)(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g;

const escapeHtmlOutsideInlineCode = (segment: string): string => {
    let escaped = '';
    let from = 0;
    for (const span of segment.matchAll(INLINE_CODE_PATTERN)) {
        escaped += escapeHtml(segment.slice(from, span.index)) + span[0];
        from = span.index + span[0].length;
    }
    return escaped + escapeHtml(segment.slice(from));
};

const mapNonFencedSegments = (markdown: string, mapSegment: (segment: string) => string): string => {
    return markdown
        .split(FENCED_CODE_SEGMENT_PATTERN)
        .map((segment, index) => (index % 2 === 1 ? segment : mapSegment(segment)))
        .join('');
};

// In Markdown a single "\n" is a soft break (rendered as a space). Users type plain
// text where each newline is meant literally, so convert soft breaks into hard breaks
// (two trailing spaces) outside of fenced code blocks, where newlines are already literal.
const applyHardLineBreaks = (markdown: string): string => {
    return mapNonFencedSegments(markdown, (segment) => segment.replace(/ *\n/g, '  \n'));
};

export const prepareUserMarkdownContent = ({
    textContent,
    agentMention,
    skillNames,
}: {
    textContent: string;
    agentMention?: AgentMentionInfo;
    skillNames: ReadonlySet<string>;
}): string => {
    let content = mapNonFencedSegments(textContent, escapeHtmlOutsideInlineCode);

    // Insert agent mention links with an internal href so markdown renders them as mentions, not external links.
    if (agentMention?.token && content.includes(agentMention.token)) {
        const mentionMarkdown = `[${agentMention.token}](${buildAgentHref(agentMention.name)})`;
        content = content.replace(agentMention.token, mentionMarkdown);
    }

    content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
        if (!skillNames.has(skillName)) return match;
        return `${prefix}[/${skillName}](${buildSkillHref(skillName)})`;
    });

    // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
    return applyHardLineBreaks(content);
};
