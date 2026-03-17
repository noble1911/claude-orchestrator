import { useState, useEffect, useMemo } from "react";
import { parseAskUserQuestionPayload, buildBundledQuestionAnswerText } from "../services/utils";
import MarkdownMessage from "./MarkdownMessage";
import type { MessageInfo, QuestionItem } from "../types";

interface QuestionCardProps {
  message: MessageInfo;
  rowId: string;
  isAnswered: boolean;
  onAnswer: (answer: string) => void;
}

function QuestionCard({ message, rowId, isAnswered, onAnswer }: QuestionCardProps) {
  const payload = useMemo(() => parseAskUserQuestionPayload(message.content), [message.content]);
  const [selectedAnswersByQuestion, setSelectedAnswersByQuestion] = useState<Record<number, string[]>>({});

  useEffect(() => {
    setSelectedAnswersByQuestion({});
  }, [message.timestamp, message.content]);

  if (!payload) {
    return (
      <div className="mt-3">
        <MarkdownMessage content={message.content} />
      </div>
    );
  }

  const canBundleAnswers =
    payload.questions.length > 1 &&
    payload.questions.every((question) => (question.options?.length ?? 0) > 0);

  const canSubmitBundledAnswers =
    canBundleAnswers &&
    payload.questions.every((_, questionIdx) => (selectedAnswersByQuestion[questionIdx]?.length ?? 0) > 0);

  const selectOption = (questionIdx: number, question: QuestionItem, optionLabel: string) => {
    if (isAnswered) return;
    if (!canBundleAnswers) {
      onAnswer(optionLabel);
      return;
    }

    setSelectedAnswersByQuestion((prev) => {
      const existing = prev[questionIdx] || [];
      if (question.multiSelect) {
        const hasValue = existing.includes(optionLabel);
        const nextValues = hasValue
          ? existing.filter((value) => value !== optionLabel)
          : [...existing, optionLabel];
        return { ...prev, [questionIdx]: nextValues };
      }
      return { ...prev, [questionIdx]: [optionLabel] };
    });
  };

  const submitBundledAnswers = () => {
    if (isAnswered || !canSubmitBundledAnswers) return;
    onAnswer(buildBundledQuestionAnswerText(payload, selectedAnswersByQuestion));
  };

  return (
    <div className="rounded-xl border md-outline bg-white/[0.03] p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide md-text-faint">Question</div>
      <div className="space-y-3">
        {payload.questions.map((question, questionIdx) => (
          <div key={`${rowId}-question-${questionIdx}`} className="space-y-2">
            {question.header && <div className="text-xs md-text-muted">{question.header}</div>}
            {question.question && <div className="text-sm md-text-primary">{question.question}</div>}
            {question.options && question.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {question.options.map((option, optionIdx) => (
                  <button
                    key={`${rowId}-option-${questionIdx}-${optionIdx}`}
                    type="button"
                    className={`md-chip transition hover:border-white/35 disabled:cursor-not-allowed disabled:opacity-55 ${
                      canBundleAnswers && (selectedAnswersByQuestion[questionIdx] || []).includes(option.label)
                        ? "border-white/45 bg-white/12"
                        : ""
                    }`}
                    disabled={isAnswered}
                    onClick={() => selectOption(questionIdx, question, option.label)}
                    title={option.description || option.label}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!isAnswered && canBundleAnswers && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border md-outline px-3 py-1.5 text-xs font-medium md-text-primary transition hover:border-white/35 disabled:cursor-not-allowed disabled:opacity-55"
            disabled={!canSubmitBundledAnswers}
            onClick={submitBundledAnswers}
          >
            Submit answers
          </button>
          <span className="text-xs md-text-muted">
            {canSubmitBundledAnswers
              ? "Ready to send all answers."
              : "Select one option for each question before submitting."}
          </span>
        </div>
      )}
      {!isAnswered && (
        <div className={`text-xs md-text-muted ${canBundleAnswers ? "mt-2" : "mt-3"}`}>
          Or type a custom answer in the main chat box below.
        </div>
      )}
    </div>
  );
}

export default QuestionCard;
