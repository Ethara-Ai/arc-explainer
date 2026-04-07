

import { ExternalLink, Brain, Users, ShieldCheck, Target, Cpu, BarChart3, FlaskConical } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

export default function About() {
  usePageMeta({
    title: 'About – Ethara AI',
    description:
      'Learn about Ethara AI — the world\'s most trusted partner in specialised Reinforcement Learning for fine-tuning AI Models.',
    canonicalPath: '/about',
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-5xl mx-auto px-4 py-12">

        {/* Hero */}
        <div className="text-center mb-16">
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent mb-4">
            About Ethara AI
          </h1>
          <p className="text-lg text-slate-300 max-w-2xl mx-auto leading-relaxed">
            Engineering the Future of AI, One Dataset at a Time
          </p>
          <p className="text-sm text-slate-400 mt-3 max-w-xl mx-auto">
            To be the world's most trusted partner in specialised Reinforcement Learning for fine-tuning AI Models
          </p>
        </div>

        {/* Our Story */}
        <section className="mb-14">
          <div className="border border-slate-700 rounded-xl p-8 bg-slate-900/60 backdrop-blur">
            <h2 className="text-2xl font-bold text-slate-100 mb-5">Our Story</h2>
            <div className="space-y-4 text-slate-300 leading-relaxed">
              <p>
                Ethara AI began with a clear insight: the data fueling Large Language Models was too often
                generic — falling short of the precision and depth needed for world-class AI systems. We set
                out to change that.
              </p>
              <p>
                Rooted in India, we tapped into one of the world's most promising assets: its vast pool of
                curious, driven, and highly capable young minds. By mentoring and mobilizing this emerging
                talent, we've built a powerful engine for AI data innovation — one that meets the exacting
                needs of leading global tech companies.
              </p>
              <p>
                What started as a data service operation has now evolved into a strategic thought partner. We
                don't just deliver tasks — we co-engineer solutions with our clients, solving the hardest
                problems in LLM training, alignment, and evaluation. Our journey is guided by one belief:
                that breakthrough AI begins with bold vision, rigorous data, and the brilliance of people
                empowered to build.
              </p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
