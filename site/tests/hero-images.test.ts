import { describe, expect, it } from "vitest";
import {
  getEnabledHeroImages,
  parseHeroImagesCsv,
  pickInitialHeroImage,
  toCssImageUrl,
  toHeroImagePayload,
} from "../src/lib/hero-images";

describe("hero image CSV", () => {
  it("parses enabled images with editorial context in file order", () => {
    const images = parseHeroImagesCsv(`id,src,alt,label,caption,credit,position,scrim,accent,enabled
one,/hero/one.svg,"One image, with comma",One scene,First caption,Team,68% 34%,0.7,#f5b14c,yes
two,/hero/two.svg,Two image,Two scene,Second caption,Team,center,,#88d2c5,no
three,/hero/three.svg,Three image,Three scene,Third caption,Team,right bottom,0.82,#5ce1ff,yes`);

    expect(images).toEqual([
      {
        id: "one",
        src: "/hero/one.svg",
        alt: "One image, with comma",
        label: "One scene",
        caption: "First caption",
        credit: "Team",
        position: "68% 34%",
        scrim: 0.7,
        accent: "#F5B14C",
        enabled: true,
      },
      {
        id: "two",
        src: "/hero/two.svg",
        alt: "Two image",
        label: "Two scene",
        caption: "Second caption",
        credit: "Team",
        position: "center",
        scrim: 0.72,
        accent: "#88D2C5",
        enabled: false,
      },
      {
        id: "three",
        src: "/hero/three.svg",
        alt: "Three image",
        label: "Three scene",
        caption: "Third caption",
        credit: "Team",
        position: "right bottom",
        scrim: 0.82,
        accent: "#5CE1FF",
        enabled: true,
      },
    ]);
    expect(getEnabledHeroImages(images).map((image) => image.id)).toEqual([
      "one",
      "three",
    ]);
  });

  it("treats rows as enabled and derives labels unless disabled explicitly", () => {
    const images = parseHeroImagesCsv(`id,src,alt
one,/hero/one.svg,One
two,/hero/two.svg,Two`);

    expect(getEnabledHeroImages(images).map((image) => image.id)).toEqual([
      "one",
      "two",
    ]);
    expect(images[0]).toMatchObject({
      label: "One",
      position: "center center",
      scrim: 0.72,
      accent: "var(--color-signal-near-white)",
    });
  });

  it("uses the first enabled row as the initial image", () => {
    const images = parseHeroImagesCsv(`id,src,alt,enabled
one,/hero/one.svg,One,no
two,/hero/two.svg,Two,yes
three,/hero/three.svg,Three,yes`);

    expect(pickInitialHeroImage(images)?.id).toBe("two");
  });

  it("builds a browser payload from enabled rows only", () => {
    const images = parseHeroImagesCsv(`id,src,alt,label,caption,credit,position,scrim,accent,enabled
one,/hero/one.svg,One,One scene,One caption,Team,left top,0.6,#f5b14c,no
two,/hero/two.svg,Two,Two scene,Two caption,Team,75% 25%,0.8,#88d2c5,yes`);

    expect(toHeroImagePayload(images)).toEqual([
      {
        id: "two",
        src: "/hero/two.svg",
        alt: "Two",
        label: "Two scene",
        caption: "Two caption",
        credit: "Team",
        position: "75% 25%",
        scrim: 0.8,
        accent: "#88D2C5",
      },
    ]);
  });

  it("rejects empty required values", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,enabled
missing-alt,/hero/missing.svg,,yes`),
    ).toThrow("Hero image CSV has an empty required value: alt");
  });

  it("rejects unsafe image sources", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,enabled
bad,javascript:alert(1),Bad,yes`),
    ).toThrow("Hero image src must be root-relative or https");
  });

  it("rejects unsafe background positions", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,position
bad,/hero/bad.svg,Bad,url(bad)`),
    ).toThrow("Hero image position uses unsupported CSS");
  });

  it("rejects two same-axis position keywords", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,position
bad,/hero/bad.svg,Bad,top bottom`),
    ).toThrow("Hero image position uses two vertical keywords");
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,position
bad,/hero/bad.svg,Bad,left right`),
    ).toThrow("Hero image position uses two horizontal keywords");
  });

  it("keeps cross-axis and percentage positions valid", () => {
    const images = parseHeroImagesCsv(`id,src,alt,position
a,/hero/a.svg,A,left top
b,/hero/b.svg,B,center top
c,/hero/c.svg,C,top 30%
d,/hero/d.svg,D,68% 34%`);

    expect(images.map((image) => image.position)).toEqual([
      "left top",
      "center top",
      "top 30%",
      "68% 34%",
    ]);
  });

  it("rejects scrim values outside the legibility range", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,scrim
bad,/hero/bad.svg,Bad,0.2`),
    ).toThrow("Hero image scrim must be a number from 0.45 to 0.9");
  });

  it("rejects unsafe accent colors", () => {
    expect(() =>
      parseHeroImagesCsv(`id,src,alt,accent
bad,/hero/bad.svg,Bad,red`),
    ).toThrow("Hero image accent must be a six-digit hex color");
  });

  it("keeps the old active column working for generated exports", () => {
    const images = parseHeroImagesCsv(`id,src,alt,active
one,/hero/one.svg,One,yes
two,/hero/two.svg,Two,no`);

    expect(getEnabledHeroImages(images).map((image) => image.id)).toEqual([
      "one",
    ]);
  });

  it("formats CSS image URLs with quoted sources", () => {
    expect(toCssImageUrl('/hero/nj "evening".svg')).toBe(
      'url("/hero/nj \\"evening\\".svg")',
    );
  });
});
