"""Render a source-backed, day-by-day usage replay as local H.264 videos.

Values are held at exact observed daily endpoints. No interpolated token counts.
"""
import argparse
import hashlib
import json
import math
import re
import subprocess
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, FPS, DAY_FRAMES = 1920, 1080, 24, 8
INTRO_FRAMES, END_FRAMES = 72, 96
BG, PANEL, BORDER = '#0b0d13', '#141823', '#252c3d'
TEXT, DIM, ACCENT = '#f2f4fa', '#929db4', '#4ad3b0'
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
TOOLS = {'claude-code':'Claude Code','codex':'Codex','ccmr':'ccmr','dsh':'dsh',
         'zcode':'ZCode','cursor':'Cursor','antigravity':'Antigravity','workbuddy':'WorkBuddy',
         'grok':'Grok Build','opencode':'OpenCode','pi':'Pi','kimi':'Kimi Code'}
COLORS = {'claude-code':'#e58b71','codex':'#49d5a1','ccmr':'#a092ef','dsh':'#68b4df',
          'zcode':'#edc267','cursor':'#e8cda2','antigravity':'#b4a4be','workbuddy':'#ed99b3',
          'grok':'#e6edf3','opencode':'#ffab64','pi':'#58d3c2','kimi':'#a6d8ba'}
DEVICE_NAMES = {'local':'Mac','vps':'VPS','windows':'Windows','unknown':'未归属'}


@lru_cache(maxsize=64)
def font(size):
    return ImageFont.truetype(FONT, size)


def fmt(value):
    if value >= 100_000_000:
        return f'{value/100_000_000:.2f} 亿'
    if value >= 10_000:
        return f'{value/10_000:.1f} 万'
    return f'{int(value):,}'


def label(name, dimension):
    if dimension == 'tool':
        return TOOLS.get(name, name)
    return re.sub(r'-(\d+)-(\d)(?=-|$)', r'-\1.\2', name)


def color(name, dimension):
    if dimension == 'tool':
        return COLORS.get(name, '#aab4c8')
    if name.startswith('claude'): return COLORS['claude-code']
    if name.startswith(('gpt','codex','o3','o4')): return COLORS['codex']
    if name.startswith(('glm','z-ai')): return COLORS['zcode']
    if name.startswith('deepseek'): return COLORS['dsh']
    if name.startswith(('kimi','moonshot')): return COLORS['kimi']
    if name.startswith('grok'): return COLORS['grok']
    if name.startswith('gemini'): return '#93b4ff'
    if name.startswith('minimax'): return COLORS['workbuddy']
    return '#b3a2df'


def text(draw, xy, value, size=24, fill=TEXT, anchor='lt'):
    draw.text(xy, str(value), font=font(size), fill=fill, anchor=anchor)


def fit_label(draw, xy, value, width, size=25):
    if draw.textlength(value, font=font(size)) <= width:
        text(draw, xy, value, size)
        return
    # Preserve the full model name in two lines, rather than merging distinct IDs.
    split = max(1, len(value)//2)
    points = [i for i, c in enumerate(value) if c in '-./']
    if points: split = min(points, key=lambda i:abs(i-split)) + 1
    first, second = value[:split], value[split:]
    if max(draw.textlength(first,font=font(size-2)),draw.textlength(second,font=font(size-2))) > width:
        # Safe end truncation is rare; exact identifiers remain in the supplied CSV/JSON.
        first, second = value[:22], value[22:44] + ('…' if len(value)>44 else '')
    text(draw, (xy[0],xy[1]-9), first, size-2)
    text(draw, (xy[0],xy[1]+17), second, size-2)


def nice_max(value):
    if value <= 0: return 1_000_000
    power = 10**math.floor(math.log10(value))
    for multiplier in [1,2,2.5,5,10]:
        if value <= power*multiplier: return power*multiplier


class Replay:
    def __init__(self, data):
        self.data = data
        self.days = data['days']
        self.daily = {'tool':defaultdict(Counter),'model':defaultdict(Counter)}
        self.devices = defaultdict(Counter)
        self.totals = Counter()
        self.counts = Counter()
        for row in data['rows']:
            for dimension in ['tool','model']:
                self.daily[dimension][row['day']][row[dimension]] += row['tokens']
            self.devices[row['day']][row['device']] += row['tokens']
            self.totals[row['day']] += row['tokens']
            self.counts[row['day']] += row['events']
        self.cumulative, self.cum_totals = {'tool':[], 'model':[]}, []
        accum = {'tool':Counter(), 'model':Counter()}
        amount = 0
        for day in self.days:
            amount += self.totals[day]
            self.cum_totals.append(amount)
            for dimension in accum:
                accum[dimension].update(self.daily[dimension][day])
                self.cumulative[dimension].append(accum[dimension].copy())
        assert amount == data['totalTokens']
        assert sum(self.counts.values()) == data['events']
        self.peak = max(self.totals.values())
        self.export_time = data['capturedAt'][11:16]
        self.month_ticks = [0] + [i for i,d in enumerate(self.days[1:],1) if d.endswith('-01')] + [len(self.days)-1]

    def footer(self, draw):
        text(draw,(56,1048),'本地已采集/同步日志  ·  Asia/Taipei  ·  Total tokens，含缓存与日志估算',19,DIM)
        text(draw,(1864,1048),f"{self.data['end'][5:].replace('-','/')} 截至 {self.export_time}，末日未结束",19,DIM,'rt')

    def trend(self, draw, index, y=910, height=120):
        draw.rounded_rectangle((56,y,1864,y+height),radius=12,fill=PANEL,outline=BORDER,width=1)
        text(draw,(80,y+17),'全部设备 · 每日总量',23)
        text(draw,(80,y+55),'固定纵轴：0—'+fmt(self.peak),18,DIM)
        left,right,top,bottom = 422,1835,y+16,y+height-36
        draw.line((left,bottom,right,bottom),fill=BORDER,width=1)
        draw.line((left,top,right,top),fill=BORDER,width=1)
        points = [(left+i/(len(self.days)-1)*(right-left),
                   bottom-self.totals[self.days[i]]/self.peak*(bottom-top)) for i in range(index+1)]
        if len(points)>1: draw.line(points,fill=ACCENT,width=3)
        px,py=points[-1]
        draw.line((px,top,px,bottom),fill='#40576b',width=1)
        draw.ellipse((px-4,py-4,px+4,py+4),fill=ACCENT)
        for i in self.month_ticks:
            tick=self.days[i][5:].replace('-','/')
            text(draw,(left+i/(len(self.days)-1)*(right-left),y+height-25),tick,17,DIM,'mt')

    def daily_frame(self, dimension, index):
        day = self.days[index]
        observed = self.daily[dimension][day]
        running = self.cumulative[dimension][index]
        names = [(name,n) for name,n in observed.most_common() if n>0]
        leaders = [(name,n) for name,n in running.most_common() if n>0]
        image=Image.new('RGB',(W,H),BG);draw=ImageDraw.Draw(image)
        noun = '工具' if dimension=='tool' else '模型'
        text(draw,(56,36),'TOKEN WATCHER  /  SIX-MONTH REPLAY',23,ACCENT)
        text(draw,(1864,36),'Mac  ·  VPS  ·  Windows',23,DIM,'rt')
        text(draw,(56,84),noun+'用量 · 逐日回放',52)
        text(draw,(56,149),self.data['start'].replace('-','.')+'—'+self.data['end'].replace('-','.')+
             ('  /  仅统计有 Token 记录的工具' if dimension=='tool' else '  /  模型按入库标识统计'),23,DIM)
        text(draw,(1864,79),day.replace('-','.'),62,TEXT,'rt')
        text(draw,(1864,151),f'第 {index+1:03d} / {len(self.days)} 天',23,DIM,'rt')
        cards=[(56,492),(516,952),(976,1412),(1436,1864)]
        for a,b in cards:draw.rounded_rectangle((a,196,b,305),radius=12,fill=PANEL,outline=BORDER,width=1)
        text(draw,(80,209),'当日 Tokens',22,DIM)
        text(draw,(80,248),fmt(self.totals[day]),43)
        text(draw,(540,209),'从 '+self.data['start'][5:].replace('-','/')+' 起累计',22,DIM)
        text(draw,(540,248),fmt(self.cum_totals[index]),43)
        text(draw,(1000,209),'当日第一 / 占当日全部用量',20,DIM)
        if names:
            name,value=names[0]
            shown=label(name,dimension)
            text(draw,(1000,245),shown if len(shown)<=25 else shown[:23]+'…',23,color(name,dimension))
            text(draw,(1388,276),f'{100*value/self.totals[day]:.1f}%',21,TEXT,'rt')
        else:text(draw,(1000,249),'无已记录用量',28,DIM)
        for i,device in enumerate(['local','vps','windows']):
            text(draw,(1460,210+i*29),DEVICE_NAMES[device],20,DIM)
            text(draw,(1840,210+i*29),fmt(self.devices[day][device]),20,TEXT,'rt')

        draw.rounded_rectangle((56,329,1236,886),radius=12,fill=PANEL,outline=BORDER,width=1)
        text(draw,(80,351),'当日'+noun+'排行  /  TOP 8',27)
        text(draw,(1209,356),'当日独立尺度 · tokens',21,DIM,'rt')
        left,right,top,bottom=450,1067,419,837
        maxvalue=nice_max(names[0][1] if names else 0)
        for i in range(5):
            x=left+(right-left)*i/4
            draw.line((x,top-8,x,bottom+11),fill=BORDER,width=1)
            text(draw,(x,396),fmt(maxvalue*i/4),17,DIM,'mt')
        for i,(name,value) in enumerate(names[:8]):
            y=top+i*53
            text(draw,(91,y+9),f'{i+1:02d}',22,DIM)
            fit_label(draw,(141,y+8),label(name,dimension),288,25)
            width=max(2,(right-left)*value/maxvalue)
            draw.rounded_rectangle((left,y+3,left+width,y+40),radius=5,fill=color(name,dimension))
            text(draw,(left+width+13,y+10),fmt(value),22)
        if not names:text(draw,(642,613),'本日无已记录用量',32,DIM,'mt')
        tail=sum(n for _,n in names[8:])
        text(draw,(80,857),('其余 '+str(len(names)-8)+' 个'+noun+'合计 '+fmt(tail)) if tail
             else '当日所有有记录类别均在图中；空日表示未记录用量',19,DIM)

        draw.rounded_rectangle((1260,329,1864,886),radius=12,fill=PANEL,outline=BORDER,width=1)
        text(draw,(1286,351),'截至当日累计  /  TOP 5',27)
        text(draw,(1286,386),'累计从 '+self.data['start'].replace('-','.')+' 起算',19,DIM)
        cum_max=nice_max(leaders[0][1] if leaders else 0)
        for i,(name,value) in enumerate(leaders[:5]):
            y=435+i*77
            text(draw,(1286,y),f'{i+1}. '+label(name,dimension),22,color(name,dimension))
            text(draw,(1838,y+27),fmt(value),22,TEXT,'rt')
            draw.rounded_rectangle((1286,y+39,1722,y+49),radius=3,fill=BORDER)
            draw.rounded_rectangle((1286,y+39,1286+max(2,436*value/cum_max),y+49),radius=3,fill=color(name,dimension))
        if not leaders:text(draw,(1558,612),'暂无累计记录',28,DIM,'mt')
        remainder=sum(n for _,n in leaders[5:])
        text(draw,(1286,840),'其余累计 '+fmt(remainder),21,DIM)
        self.trend(draw,index)
        self.footer(draw)
        draw.rectangle((0,H-3,int(W*(index+1)/len(self.days)),H),fill=ACCENT)
        return image

    def title_frame(self, dimension):
        image=Image.new('RGB',(W,H),BG);draw=ImageDraw.Draw(image)
        noun='工具' if dimension=='tool' else '模型'
        number='01' if dimension=='tool' else '02'
        text(draw,(56,48),'TOKEN WATCHER  /  '+number,25,ACCENT)
        text(draw,(1864,48),'Mac  ·  VPS  ·  Windows',25,DIM,'rt')
        text(draw,(56,136),noun+'用量的逐日变化',76)
        text(draw,(56,242),self.data['start'].replace('-','.')+'—'+self.data['end'].replace('-','.'),36,DIM)
        text(draw,(56,341),fmt(self.data['totalTokens']),118)
        text(draw,(57,486),f"{len(self.days)} 个日历日  /  {sum(self.totals[d]>0 for d in self.days)} 个有记录日期  /  区间 Total tokens",31,DIM)
        leaders=self.cumulative[dimension][-1].most_common(3)
        for i,(name,value) in enumerate(leaders):
            x=56+i*610
            draw.rounded_rectangle((x,568,x+586,722),radius=12,fill=PANEL,outline=BORDER,width=1)
            text(draw,(x+24,591),f'半年累计 #{i+1}',23,DIM)
            text(draw,(x+24,628),label(name,dimension),28,color(name,dimension))
            text(draw,(x+24,671),fmt(value),31)
        self.trend(draw,len(self.days)-1,770,244)
        self.footer(draw)
        return image


def encode(replay, dimension, out, ffmpeg):
    target=out/('工具-日度Token变化.mp4' if dimension=='tool' else '模型-日度Token变化.mp4')
    log=out/(dimension+'-encoding.log')
    command=[ffmpeg,'-hide_banner','-loglevel','warning','-y','-f','rawvideo','-pix_fmt','rgb24',
             '-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','veryfast',
             '-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(target)]
    frames=0
    with log.open('wb') as stderr:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=stderr)
        try:
            def send(image,repeats):
                nonlocal frames
                raw=image.tobytes()
                for _ in range(repeats):process.stdin.write(raw);frames+=1
            title=replay.title_frame(dimension)
            send(title,INTRO_FRAMES)
            for index,day in enumerate(replay.days):
                frame=replay.daily_frame(dimension,index)
                send(frame,DAY_FRAMES)
                if index%40==0:print(f'{dimension}: {day} ({index+1}/{len(replay.days)})',flush=True)
            send(replay.daily_frame(dimension,len(replay.days)-1),END_FRAMES)
        finally:process.stdin.close()
        if process.wait()!=0:raise RuntimeError('Encoding failed; see '+str(log))
    return dict(file=target.name,frames=frames,seconds=frames/FPS,
                bytes=target.stat().st_size,sha256=hashlib.sha256(target.read_bytes()).hexdigest())


def render(data_path, out, ffmpeg, preview_only=False):
    data=json.loads(data_path.read_text())
    replay=Replay(data)
    out.mkdir(parents=True,exist_ok=True)
    peak_index=max(range(len(replay.days)),key=lambda i:replay.totals[replay.days[i]])
    replay.title_frame('tool').save(out/'封面.png')
    for dimension in ['tool','model']:
        for tag,index in [('peak',peak_index),('final',len(replay.days)-1),('early',3)]:
            replay.daily_frame(dimension,index).save(out/f'{dimension}-{tag}-preview.png')
    if preview_only:
        print('Preview images ready:',out,flush=True)
        return
    clips=[encode(replay,dim,out,ffmpeg) for dim in ['tool','model']]
    listing=out/'concat.txt'
    listing.write_text(''.join("file '"+clip['file']+"'\n" for clip in clips))
    chapter_file=out/'chapters.ffmetadata'
    duration=round(clips[0]['seconds']*1000)
    chapter_file.write_text(f';FFMETADATA1\ntitle=近半年多设备Token日度变化\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND={duration}\ntitle=01 工具用量变化\n[CHAPTER]\nTIMEBASE=1/1000\nSTART={duration}\nEND={round(sum(c["seconds"] for c in clips)*1000)}\ntitle=02 模型用量变化\n')
    combined=out/'多设备-近半年Token动态变化.mp4'
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','warning','-y','-f','concat','-safe','0','-i',str(listing),
                    '-i',str(chapter_file),'-map_metadata','1','-map_chapters','1','-c','copy',
                    '-movflags','+faststart',str(combined)],check=True)
    result=dict(width=W,height=H,fps=FPS,dayFrames=DAY_FRAMES,start=data['start'],end=data['end'],
                capturedAt=data['capturedAt'],totalTokens=data['totalTokens'],
                dailyValues='exact recorded endpoints; no numeric interpolation',clips=clips,
                combined=dict(file=combined.name,seconds=sum(c['seconds'] for c in clips),
                              bytes=combined.stat().st_size,sha256=hashlib.sha256(combined.read_bytes()).hexdigest()),
                sourceSha256=hashlib.sha256(data_path.read_bytes()).hexdigest())
    (out/'render-manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--data',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--ffmpeg',default='/opt/homebrew/bin/ffmpeg')
    parser.add_argument('--preview-only',action='store_true')
    args=parser.parse_args()
    render(args.data,args.out,args.ffmpeg,args.preview_only)
