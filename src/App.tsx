import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { 
  BarChart, 
  Users, 
  FileVideo, 
  Activity, 
  ShieldCheck, 
  Database,
  ArrowRight,
  RefreshCw,
  Search
} from 'lucide-react';

interface Stats {
  totalFiles: number;
  totalUsers: number;
  todayRequests: number;
}

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<any>(null);

  const fetchStats = async () => {
    try {
      const [resStats, resHealth] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/health')
      ]);
      
      const statsData = await resStats.json();
      const healthData = await resHealth.json();
      
      if (!resStats.ok) {
        console.error('Stats fetch error:', statsData.details || statsData.error);
        // We still set it so UI can show 0s or handle error state
      }
      
      setStats(statsData);
      setHealth(healthData);
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10000); // Pulse every 10s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#F0F0F0] text-[#1A1A1A] font-sans selection:bg-[#FFD600]">
      {/* Header */}
      <header className="border-b-4 border-black bg-white p-6 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="bg-[#FFD600] border-4 border-black p-2 rotate-[-2deg]">
              <Database className="w-8 h-8" strokeWidth={3} />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tighter uppercase leading-none">Vinehill Command</h1>
              <p className="font-mono text-sm font-bold opacity-60">ADMINISTRATION INTERFACE V1.0</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 bg-white border-2 border-black px-4 py-2 font-mono text-sm font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
              <div className={`w-3 h-3 rounded-full ${health?.bot ? 'bg-green-500' : 'bg-red-500'} border-2 border-black`} />
              SYSTEM {health?.bot ? 'ONLINE' : 'OFFLINE'}
            </div>
            <button 
              onClick={fetchStats}
              className="bg-[#00F0FF] border-2 border-black p-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-8 grid grid-cols-1 md:grid-cols-12 gap-8">
        
        {/* Stats Grid */}
        <div className="col-span-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatCard 
            label="Total Library" 
            value={stats?.totalFiles || 0} 
            icon={<FileVideo className="w-8 h-8" />}
            color="bg-white"
            unit="FILES"
          />
          <StatCard 
            label="Active Users" 
            value={stats?.totalUsers || 0} 
            icon={<Users className="w-8 h-8" />}
            color="bg-[#FF8A00]"
            unit="REG"
          />
          <StatCard 
            label="Requests Today" 
            value={stats?.todayRequests || 0} 
            icon={<Activity className="w-8 h-8" />}
            color="bg-[#00FF47]"
            unit="REQ"
          />
        </div>

        {/* Live Feed Placeholder */}
        <div className="col-span-12 md:col-span-8 space-y-6">
          <div className="bg-white border-4 border-black p-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black uppercase tracking-tight">Deployment Strategy</h2>
              <ShieldCheck className="w-8 h-8" />
            </div>
            
            <div className="space-y-4 font-bold">
              <div className="p-4 bg-[#F0F0F0] border-2 border-black flex items-center justify-between group cursor-default">
                <span>FIRESTORE CLOUD SYNC</span>
                <span className="text-green-600 uppercase italic">Immutable Backup Active</span>
              </div>
              <div className="p-4 bg-[#F0F0F0] border-2 border-black flex items-center justify-between group cursor-default">
                <span>TMDB METADATA AGENT</span>
                <span className={process.env.TMDB_API_KEY ? 'text-green-600' : 'text-red-500'}>
                  {process.env.TMDB_API_KEY ? 'READY' : 'CONFIG MISSING'}
                </span>
              </div>
              <div className="p-4 bg-[#F0F0F0] border-2 border-black flex items-center justify-between group cursor-default">
                <span>CHANNEL FORCE-SUBSCRIBE GATES</span>
                <span className="text-[#FF8A00]">6 ACTIVE</span>
              </div>
            </div>
            
            <div className="mt-8 p-6 bg-black text-white font-mono text-sm leading-relaxed overflow-hidden relative">
              <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:20px_20px]" />
              <p className="text-green-400">$ systemctl status vinehill-bot</p>
              <p className="opacity-80">● vinehill-bot.service - Telegram Distribution Bot</p>
              <p className="opacity-80">   Loaded: loaded (/etc/systemd/system/vinehill-bot.service)</p>
              <p className="text-yellow-400">   Active: active (running) since {new Date().toLocaleDateString()}</p>
              <p className="opacity-50 mt-4">Waiting for new media packets...</p>
            </div>
          </div>
        </div>

        {/* Sidebar Info */}
        <div className="col-span-12 md:col-span-4 space-y-8">
          <div className="bg-[#FFD600] border-4 border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
            <h3 className="font-black text-xl mb-4 uppercase italic">Cloud Immunity</h3>
            <p className="font-bold text-sm leading-tight mb-4">
              <b>Cloud Persistence Active:</b> Your indices are now synced to Firestore. 
              If the instance resets, the bot will auto-restore from the cloud.
            </p>
            <div className="flex gap-2">
               <code className="text-xs font-black bg-white border-2 border-black p-1">V 1.1.0-FIREBASE</code>
               <code className="text-xs font-black bg-green-600 text-white border-2 border-black p-1">AUTO-SYNC ON</code>
            </div>
          </div>

          <div className="bg-white border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between font-bold uppercase transition-all hover:bg-[#FF8A00] cursor-pointer group"
               onClick={async () => {
                 if (confirm('Are you sure you want to clear and re-announce ALL posts? This will brute-force delete messages in your public channels.')) {
                   setLoading(true);
                   await fetch('/api/reannounce', { method: 'POST' });
                   setLoading(false);
                   alert('Channel wipe and mass re-announcement started in background.');
                 }
               }}>
             <span>Force Channel Wipe</span>
             <RefreshCw className={`group-hover:rotate-180 transition-transform duration-500 ${loading ? 'animate-spin' : ''}`} />
          </div>

          <div className="bg-white border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between font-bold uppercase transition-all hover:bg-[#00FF47] cursor-pointer group"
               onClick={() => alert('Feature coming soon: Manual backup via API. Use /backup in Telegram for now.')}>
             <span>Database Backup</span>
             <Database className="w-5 h-5 group-hover:scale-110 transition-transform" />
          </div>

          <div className="bg-white border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between font-bold uppercase transition-all hover:bg-[#00F0FF] cursor-pointer group">
             <span>Access Logs</span>
             <ArrowRight className="group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

      </main>
    </div>
  );
}

function StatCard({ label, value, icon, color, unit }: any) {
  return (
    <motion.div 
      whileHover={{ scale: 1.02 }}
      className={`${color} border-4 border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex items-center justify-between`}
    >
      <div>
        <p className="font-black uppercase text-sm mb-1 opacity-60 tracking-wider">{label}</p>
        <div className="flex items-baseline gap-2">
          <h4 className="text-5xl font-black tracking-tighter tabular-nums">{value}</h4>
          <span className="font-bold text-xs opacity-40">{unit}</span>
        </div>
      </div>
      <div className="opacity-20 transform scale-150 rotate-[10deg]">
        {icon}
      </div>
    </motion.div>
  );
}
