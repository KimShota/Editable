import { ASSETS, copy, REELS } from "../landing-copy";
import { LoopReel } from "./LoopReel";

/**
 * Still the founder's voice: the same reel, first on my account, then as the
 * one post on a brand-new app account. The Brainlot profile is a styled copy
 * of an Instagram profile header; its numbers are rounded so they stay true.
 */
export function Bridge() {
  const b = copy.bridge;
  const reel = REELS[4];
  return (
    <section className="bridge" id="proof">
      <div className="bridge__inner">
        <p className="kicker" data-reveal>{b.kicker}</p>
        <h2 className="bridge__title" data-reveal>{b.title}</h2>
        <p className="bridge__sub" data-reveal>{b.sub}</p>

        <div className="bridge__stage" data-reveal>
          <figure className="bridge__mine">
            <div className="phone">
              <LoopReel src={reel.src} poster={reel.poster} />
            </div>
            <figcaption>
              <strong>{b.mine}</strong>
              <span>@shota_matsumotooo · ♥ {reel.likes}</span>
            </figcaption>
          </figure>

          <div className="bridge__arrow" aria-hidden="true">→</div>

          <figure className="bridge__theirs">
            <div className="ig">
              <div className="ig__top">
                <img className="ig__avatar" src={ASSETS.brainlotAvatar} alt="" width={72} height={72} />
                <div>
                  <p className="ig__handle">{b.profile.handle}</p>
                  <ul className="ig__stats">
                    <li><strong>{b.profile.postsValue}</strong> {b.profile.posts}</li>
                    <li><strong>{b.profile.followersValue}</strong> {b.profile.followers}</li>
                    <li><strong>{b.profile.followingValue}</strong> {b.profile.following}</li>
                  </ul>
                </div>
              </div>
              <p className="ig__name">{b.profile.name}</p>
              {b.profile.bio.map((line) => (
                <p className="ig__bio" key={line}>{line}</p>
              ))}
              <div className="ig__grid">
                <div className="ig__cell">
                  <LoopReel src={reel.src} poster={reel.poster} />
                </div>
                <div className="ig__cell ig__cell--empty" />
                <div className="ig__cell ig__cell--empty" />
              </div>
            </div>
            <figcaption>
              <strong>{b.theirs}</strong>
              <span>@brainlot.app</span>
            </figcaption>
          </figure>
        </div>

        <p className="bridge__sig" data-reveal>{b.signature}</p>
      </div>
    </section>
  );
}
