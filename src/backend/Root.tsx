import { Composition } from "remotion";
import { TemplateVideo, totalFrames } from "./TemplateVideo";
import { csResourcesTemplate } from "./templates/csResources";
import { EdlVideo, calculateEdlMetadata } from "./remotion/EdlVideo";
import { defaultEdl } from "./remotion/defaultEdl";
import { StickerTitle } from "./remotion/components/StickerTitle";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The pipeline's renderer: duration/fps/size derive from the EDL props. */}
      <Composition
        id="EdlVideo"
        component={EdlVideo}
        durationInFrames={60}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ edl: defaultEdl }}
        calculateMetadata={calculateEdlMetadata}
      />
      {/* Preview-only: the "5 SECRET / Claude codes" hook title sticker. */}
      <Composition
        id="StickerTitle"
        component={StickerTitle}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          patchText: "5",
          headline: "SECRET",
          subhead: "Claude codes",
          fontSize: 80,
        }}
      />
      {/* Legacy hand-built template, kept for reference. */}
      <Composition
        id="CsResources"
        component={TemplateVideo}
        durationInFrames={totalFrames(csResourcesTemplate)}
        fps={csResourcesTemplate.fps}
        width={csResourcesTemplate.width}
        height={csResourcesTemplate.height}
        defaultProps={{ template: csResourcesTemplate }}
      />
    </>
  );
};
