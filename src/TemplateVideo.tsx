import React from "react";
import { AbsoluteFill, Sequence, Audio, staticFile } from "remotion";
import { Template } from "./templates/csResources";
import { HookBlock } from "./components/HookBlock";
import { ResourceBlock } from "./components/ResourceBlock";
import { CtaBlock } from "./components/CtaBlock";

/**
 * TemplateVideo reads a Template config and lays out each block in
 * sequence. This single component renders ANY template — the format
 * lives entirely in the config object, not here. That's the whole
 * point: new format = new config, not new code.
 */

export const TemplateVideo: React.FC<{ template: Template }> = ({
  template,
}) => {
  const { blocks, audio } = template;

  let cursor = 0; // running frame position

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {audio ? <Audio src={staticFile(audio.src)} /> : null}

      {blocks.map((block, i) => {
        const durationInFrames = block.durationInFrames;
        const from = cursor;
        cursor += durationInFrames;

        return (
          <Sequence
            key={i}
            from={from}
            durationInFrames={durationInFrames}
            name={`${block.type}-${i}`}
          >
            {block.type === "hook" && (
              <HookBlock
                clip={block.clip}
                textHook={block.textHook}
                resolveText={block.resolveText}
                resolveAtFrame={block.resolveAtFrame}
              />
            )}
            {block.type === "resource" && (
              <ResourceBlock
                clip={block.clip}
                title={block.title}
                description={block.description}
              />
            )}
            {block.type === "cta" && (
              <CtaBlock clip={block.clip} text={block.text} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/** Total duration in frames for a template (used by Root). */
export const totalFrames = (template: Template): number =>
  template.blocks.reduce((sum, b) => sum + b.durationInFrames, 0);
