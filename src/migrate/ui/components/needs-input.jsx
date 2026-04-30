// Needs-input modal — pops up when the server emits {kind:"needs_input", ...}
// Supports three input types: boolean, choice, text.

const { useState: useSI, useEffect: useSIE } = React;

function NeedsInputModal({ question, onAnswer, onSkip }) {
  const type = question?.type || (question?.options?.length ? "choice" : "text");
  const [text, setText] = useSI(question?.default || "");
  const [applyAll, setApplyAll] = useSI(true);
  useSIE(() => { setText(question?.default || ""); }, [question?.qid]);

  if (!question) return null;
  const multiline = type === "text" && (question?.default || "").includes("\n");

  return (
    <div className="fixed inset-0 z-50 bg-[#010409cc] backdrop-blur-sm flex items-center justify-center px-4">
      <div className="w-full max-w-[520px] bg-[#0d1117] border border-[#58a6ff80] rounded-[6px] shadow-2xl">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[#21262d]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff]"/>
          <h2 className="font-serif text-[20px] leading-none text-[#e6edf3]">Needs your input</h2>
          <span className="text-[11px] text-[#6e7681] ml-auto">job paused</span>
        </div>

        <div className="px-5 py-4">
          <div className="text-[11px] text-[#6e7681] mb-1">
            While importing <span className="font-serif text-[15px] text-[#e6edf3]">{question.itemName}</span>
          </div>
          <div className="text-[14px] text-[#e6edf3] mb-2 leading-relaxed">
            {question.question}
          </div>
          {question.context && (
            <div className="text-[11px] text-[#8b949e] mb-4 leading-relaxed italic border-l-2 border-[#30363d] pl-2">
              {question.context}
            </div>
          )}

          {type === "boolean" && (
            <div className="flex gap-2">
              <button
                onClick={() => onAnswer("true", applyAll)}
                className="flex-1 px-3 py-2.5 bg-[#1f6feb] hover:bg-[#388bfd] rounded-[4px] text-[13px] font-medium text-white"
              >{question.trueLabel || "Yes"}</button>
              <button
                onClick={() => onAnswer("false", applyAll)}
                className="flex-1 px-3 py-2.5 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-[4px] text-[13px] font-medium text-[#e6edf3]"
              >{question.falseLabel || "No"}</button>
            </div>
          )}

          {type === "choice" && (
            <div className={"space-y-1.5 " + ((question.options || []).length > 8 ? "max-h-[360px] overflow-y-auto pr-1" : "")}>
              {(question.options || []).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onAnswer(opt.value, applyAll)}
                  className="w-full text-left px-3 py-2 bg-[#010409] border border-[#30363d] hover:border-[#58a6ff] rounded-[4px] text-[12px] text-[#e6edf3] flex items-baseline gap-3"
                >
                  <span className="text-[#58a6ff] font-mono text-[11px]">{opt.value}</span>
                  <span className="text-[#8b949e]">{opt.label}</span>
                </button>
              ))}
            </div>
          )}

          {type === "text" && (
            <div className="flex gap-2">
              {multiline ? (
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  autoFocus
                  className="flex-1 bg-[#010409] border border-[#30363d] rounded-[4px] px-2.5 py-2 text-[13px] text-[#e6edf3] placeholder:text-[#484f58] focus:outline-none focus:border-[#58a6ff] font-mono"
                />
              ) : (
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && text && onAnswer(text, applyAll)}
                  placeholder={question.placeholder || "Type your answer…"}
                  autoFocus
                  className="flex-1 bg-[#010409] border border-[#30363d] rounded-[4px] px-2.5 py-2 text-[13px] text-[#e6edf3] placeholder:text-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                />
              )}
              <button
                onClick={() => text && onAnswer(text, applyAll)}
                disabled={!text}
                className="text-[12px] font-medium text-white bg-[#1f6feb] hover:bg-[#388bfd] disabled:bg-[#21262d] disabled:text-[#6e7681] px-3 py-2 rounded-[4px] self-start"
              >Submit</button>
            </div>
          )}

          {!question.hideApplyAll && (
            <label className="flex items-center gap-2 mt-3 text-[11px] text-[#8b949e] cursor-pointer">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
                className="w-3 h-3 accent-[#58a6ff] cursor-pointer"
              />
              Apply to other items with the same question in this job
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#21262d] bg-[#010409]">
          <button
            onClick={onSkip}
            className="text-[11px] text-[#8b949e] hover:text-[#f85149] px-3 py-1.5"
          >Skip this item</button>
        </div>
      </div>
    </div>
  );
}

window.NeedsInputModal = NeedsInputModal;
