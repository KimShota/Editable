import { Composition } from "remotion";
import { TemplateVideo, totalFrames } from "./TemplateVideo";
import { csResourcesTemplate } from "./templates/csResources";

export const RemotionRoot: React.FC = () => {
  return (
    <>
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
