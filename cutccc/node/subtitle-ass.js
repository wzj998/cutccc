import { subtitleLayout } from "../web/subtitle-style.js";

const color = (hex) => "&H00" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
const textUnits = text => [...text].reduce((n,c) => n + (/[^\x00-\x7f]/u.test(c) ? 1 : /[MW@#%&]/.test(c) ? .95 : /[\s ilI1.,:;'!|]/.test(c) ? .35 : .65),0);
export function wrapExportCues(cues,width,height) {
  return cues.map(cue => {
    const layout=subtitleLayout(cue.style,width,height), hard=layout.maxWidth/layout.fontPixels, limit=hard*.9;
    const paragraphs=cue.text.split(/\r\n|\r|\n/).flatMap(paragraph=>{
      if (textUnits(paragraph) <= hard*.98) return [paragraph];
      const lines=[[]];
      const original=paragraph.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[ \t]+|./gu)||[];
      const tokens=original.flatMap(t=>textUnits(t)>limit?[...t]:[t]);
      for(const token of tokens){
        let line=lines.at(-1);
        const closing=/^[，。！？；：、）》”’]$/u.test(token);
        if(line.length && textUnits(line.join('')+token)>(closing?hard:limit)){lines.push([]);line=lines.at(-1);}
        line.push(token);
      }
      // Avoid a very short final line while preserving words, punctuation and the exact characters.
      if(lines.length>1){
        const last=lines.at(-1),previous=lines.at(-2);
        while(previous.length>1 && textUnits(last.join(''))<textUnits(previous.join(''))*.55){
          const count=/^[，。！？；：、）》”’]$/u.test(previous.at(-1))?2:1;
          if(previous.length<=count)break;
          const moved=previous.slice(-count);
          if(textUnits(moved.join('')+last.join(''))>limit)break;
          last.unshift(...previous.splice(-count));
        }
      }
      return lines.map(line=>line.join(''));
    });
    return {...cue,text:paragraphs.join('\n')};
  });
}
function assTime(seconds) {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
export function assText(text) {
  // libass literal braces; a word joiner stops literal backslashes becoming tags.
  // See FFmpeg libavcodec/ass.c, ff_ass_bprint_text_event.
  return text.replace(/\\/g, "\\\u2060").replace(/{/g, "\\{").replace(/}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\N");
}
export function toAss(cues, width, height) {
  const styles = [], events = [];
  for (const [i, cue] of cues.entries()) {
    const s = subtitleLayout(cue.style, width, height);
    const name = `Cue${i}`;
    const margin = Math.round(width * s.marginX / 100);
    styles.push(`Style: ${name},${s.fontFamily},${s.fontPixels.toFixed(3)},${color(s.color)},${color(s.color)},${color(s.outlineColor)},&H00000000,${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,0,0,1,${s.outlinePixels.toFixed(3)},0,${s.alignment},${margin},${margin},${Math.round(height * s.marginY / 100)},1`);
    const end = Math.max(cue.end, Math.round(cue.start * 100) / 100 + .01);
    events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(end)},${name},,0,0,0,,{\\pos(${s.x.toFixed(3)},${s.y.toFixed(3)})}${assText(cue.text)}`);
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 1\nYCbCr Matrix: None\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join("\n")}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}
