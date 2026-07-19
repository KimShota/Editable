import { Composition } from "remotion";
import { TemplateVideo, totalFrames } from "./TemplateVideo";
import { csResourcesTemplate } from "./templates/csResources";
import { EdlVideo, calculateEdlMetadata } from "./remotion/EdlVideo";
import { defaultEdl } from "./remotion/defaultEdl";

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
