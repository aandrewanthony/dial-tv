export type Channel={id:string;number:number;name:string;group:string;logo:string;url:string};
export type Program={id:string;channelId:string;title:string;subtitle?:string;start:string;end:string;category:string;live?:boolean};
export type SportEvent={id:string;league:string;away:string;home:string;time:string;channelId:string;status:string};
export const channels:Channel[]=[
{id:'bbb',number:101,name:'Big Buck Bunny',group:'Demo',logo:'BB',url:'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'},
{id:'sintel',number:102,name:'Sintel',group:'Movies',logo:'SI',url:'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8'},
{id:'apple',number:103,name:'Apple Demo',group:'Demo',logo:'AD',url:'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8'}];
const now=Date.now(), hr=3600000;
const p=(id:string,c:string,t:string,off:number,len:number,cat:string):Program=>({id,channelId:c,title:t,start:new Date(now+off*hr).toISOString(),end:new Date(now+(off+len)*hr).toISOString(),category:cat,live:off<=0&&off+len>0});
export const programs=[p('p1','bbb','Morning Mix',-1,.75,'Entertainment'),p('p2','bbb','Open Cinema',-.25,1.5,'Movie'),p('p3','bbb','Indie Showcase',1.25,1,'Arts'),p('p4','sintel','Animation Hour',-1,.8,'Movie'),p('p5','sintel','Sintel',-.2,1.4,'Movie'),p('p6','sintel','Behind the Frames',1.2,1,'Documentary'),p('p7','apple','Tech Today',-1,.7,'News'),p('p8','apple','Live Demo Network',-.3,1.3,'Technology'),p('p9','apple','Future Screen',1,1.2,'Technology')];
export const sports:SportEvent[]=[{id:'s1',league:'MLB',away:'New York',home:'Boston',time:new Date(now+2*hr).toISOString(),channelId:'apple',status:'Upcoming'},{id:'s2',league:'NBA',away:'Chicago',home:'New York',time:new Date(now+5*hr).toISOString(),channelId:'bbb',status:'Upcoming'},{id:'s3',league:'NHL',away:'Montreal',home:'New York',time:new Date(now+26*hr).toISOString(),channelId:'sintel',status:'Tomorrow'}];
