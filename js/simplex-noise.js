// Simplex Noise 3D with fBm and ridged fBm variants.

import { makeRng } from './rng.js';

export class SimplexNoise {
    constructor(seed = 0) {
        this.G = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
        const rng = makeRng(seed);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        for (let i = 255; i > 0; i--) { const j = Math.floor(rng()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
        this.perm = new Uint8Array(512);
        this.pm12 = new Uint8Array(512);
        for (let i = 0; i < 512; i++) { this.perm[i] = p[i&255]; this.pm12[i] = this.perm[i]%12; }
        // Reused by erosiveFbm so derivative-aware sampling does not allocate
        // once per octave (or, transitively, once per terrain cell).
        this._derivativeScratch = new Float64Array(4);
    }

    noise3D(x,y,z) {
        const F=1/3,H=1/6,s=(x+y+z)*F;
        const i=Math.floor(x+s),j=Math.floor(y+s),k=Math.floor(z+s);
        const t=(i+j+k)*H,x0=x-i+t,y0=y-j+t,z0=z-k+t;
        let i1,j1,k1,i2,j2,k2;
        if(x0>=y0){if(y0>=z0){i1=1;j1=0;k1=0;i2=1;j2=1;k2=0;}else if(x0>=z0){i1=1;j1=0;k1=0;i2=1;j2=0;k2=1;}else{i1=0;j1=0;k1=1;i2=1;j2=0;k2=1;}}
        else{if(y0<z0){i1=0;j1=0;k1=1;i2=0;j2=1;k2=1;}else if(x0<z0){i1=0;j1=1;k1=0;i2=0;j2=1;k2=1;}else{i1=0;j1=1;k1=0;i2=1;j2=1;k2=0;}}
        const x1=x0-i1+H,y1=y0-j1+H,z1=z0-k1+H,x2=x0-i2+2*H,y2=y0-j2+2*H,z2=z0-k2+2*H,x3=x0-1+3*H,y3=y0-1+3*H,z3=z0-1+3*H;
        const ii=i&255,jj=j&255,kk=k&255,{perm:P,pm12:M,G:g}=this;
        let n0=0,n1=0,n2=0,n3=0;
        let a=0.6-x0*x0-y0*y0-z0*z0;if(a>0){a*=a;const v=g[M[ii+P[jj+P[kk]]]];n0=a*a*(v[0]*x0+v[1]*y0+v[2]*z0);}
        let b=0.6-x1*x1-y1*y1-z1*z1;if(b>0){b*=b;const v=g[M[ii+i1+P[jj+j1+P[kk+k1]]]];n1=b*b*(v[0]*x1+v[1]*y1+v[2]*z1);}
        let c=0.6-x2*x2-y2*y2-z2*z2;if(c>0){c*=c;const v=g[M[ii+i2+P[jj+j2+P[kk+k2]]]];n2=c*c*(v[0]*x2+v[1]*y2+v[2]*z2);}
        let d=0.6-x3*x3-y3*y3-z3*z3;if(d>0){d*=d;const v=g[M[ii+1+P[jj+1+P[kk+1]]]];n3=d*d*(v[0]*x3+v[1]*y3+v[2]*z3);}
        return 32*(n0+n1+n2+n3);
    }

    /**
     * 3D simplex value and analytical derivatives.
     *
     * `out` is caller-owned and filled as [value, dx, dy, dz]. Keeping the
     * value-only sampler separate protects the generator's classic path from
     * any floating-point reordering when experimental sampling is disabled.
     */
    noise3DWithDerivatives(x, y, z, out) {
        const F=1/3,H=1/6,s=(x+y+z)*F;
        const i=Math.floor(x+s),j=Math.floor(y+s),k=Math.floor(z+s);
        const skew=(i+j+k)*H,x0=x-i+skew,y0=y-j+skew,z0=z-k+skew;
        let i1,j1,k1,i2,j2,k2;
        if(x0>=y0){if(y0>=z0){i1=1;j1=0;k1=0;i2=1;j2=1;k2=0;}else if(x0>=z0){i1=1;j1=0;k1=0;i2=1;j2=0;k2=1;}else{i1=0;j1=0;k1=1;i2=1;j2=0;k2=1;}}
        else{if(y0<z0){i1=0;j1=0;k1=1;i2=0;j2=1;k2=1;}else if(x0<z0){i1=0;j1=1;k1=0;i2=0;j2=1;k2=1;}else{i1=0;j1=1;k1=0;i2=1;j2=1;k2=0;}}
        const x1=x0-i1+H,y1=y0-j1+H,z1=z0-k1+H,x2=x0-i2+2*H,y2=y0-j2+2*H,z2=z0-k2+2*H,x3=x0-1+3*H,y3=y0-1+3*H,z3=z0-1+3*H;
        const ii=i&255,jj=j&255,kk=k&255,{perm:P,pm12:M,G:g}=this;
        let value=0,dx=0,dy=0,dz=0;

        let t=0.6-x0*x0-y0*y0-z0*z0;
        if(t>0){
            const v=g[M[ii+P[jj+P[kk]]]],dot=v[0]*x0+v[1]*y0+v[2]*z0;
            const t2=t*t,t3=t2*t,t4=t2*t2,radial=8*t3*dot;
            value+=t4*dot;dx+=t4*v[0]-radial*x0;dy+=t4*v[1]-radial*y0;dz+=t4*v[2]-radial*z0;
        }
        t=0.6-x1*x1-y1*y1-z1*z1;
        if(t>0){
            const v=g[M[ii+i1+P[jj+j1+P[kk+k1]]]],dot=v[0]*x1+v[1]*y1+v[2]*z1;
            const t2=t*t,t3=t2*t,t4=t2*t2,radial=8*t3*dot;
            value+=t4*dot;dx+=t4*v[0]-radial*x1;dy+=t4*v[1]-radial*y1;dz+=t4*v[2]-radial*z1;
        }
        t=0.6-x2*x2-y2*y2-z2*z2;
        if(t>0){
            const v=g[M[ii+i2+P[jj+j2+P[kk+k2]]]],dot=v[0]*x2+v[1]*y2+v[2]*z2;
            const t2=t*t,t3=t2*t,t4=t2*t2,radial=8*t3*dot;
            value+=t4*dot;dx+=t4*v[0]-radial*x2;dy+=t4*v[1]-radial*y2;dz+=t4*v[2]-radial*z2;
        }
        t=0.6-x3*x3-y3*y3-z3*z3;
        if(t>0){
            const v=g[M[ii+1+P[jj+1+P[kk+1]]]],dot=v[0]*x3+v[1]*y3+v[2]*z3;
            const t2=t*t,t3=t2*t,t4=t2*t2,radial=8*t3*dot;
            value+=t4*dot;dx+=t4*v[0]-radial*x3;dy+=t4*v[1]-radial*y3;dz+=t4*v[2]-radial*z3;
        }

        out[0]=32*value;out[1]=32*dx;out[2]=32*dy;out[3]=32*dz;
        return out;
    }

    fbm(x,y,z,octaves=5,persistence=2/3) {
        let sum=0,max=0,amp=1;
        for(let o=0;o<octaves;o++){const f=1<<o;sum+=amp*this.noise3D(x*f,y*f,z*f);max+=amp;amp*=persistence;}
        return sum/max;
    }

    /**
     * Derivative-suppressed fBm (the experimental "Morenoise" mode).
     * Octave-local derivatives are projected onto the caller's tangent plane
     * and accumulated with amplitude, deliberately omitting the frequency
     * chain factor. The ordinary amplitude sum remains the denominator so
     * suppression is visible instead of being normalized away.
     */
    erosiveFbm(x, y, z, nx, ny, nz, octaves=5, persistence=2/3, gradientStrength=1) {
        const normalLen=Math.hypot(nx,ny,nz);
        if(normalLen>0){nx/=normalLen;ny/=normalLen;nz/=normalLen;}
        else{nx=0;ny=0;nz=1;}

        let sum=0,max=0,amp=1,freq=1;
        let adx=0,ady=0,adz=0;
        const out=this._derivativeScratch;
        const strength=gradientStrength>0?gradientStrength:0;
        for(let o=0;o<octaves;o++){
            this.noise3DWithDerivatives(x*freq,y*freq,z*freq,out);
            const normalPart=out[1]*nx+out[2]*ny+out[3]*nz;
            adx+=amp*(out[1]-normalPart*nx);
            ady+=amp*(out[2]-normalPart*ny);
            adz+=amp*(out[3]-normalPart*nz);
            const weight=1/(1+strength*(adx*adx+ady*ady+adz*adz));
            sum+=amp*out[0]*weight;
            max+=amp;
            amp*=persistence;
            freq*=2;
        }
        return max>0?sum/max:0;
    }

    ridgedFbm(x, y, z, octaves = 6, lacunarity = 2.0, gain = 0.5, offset = 1.0) {
        let sum = 0, freq = 1, amp = 1, prev = 1, maxVal = 0;
        for (let o = 0; o < octaves; o++) {
            let n = this.noise3D(x * freq, y * freq, z * freq);
            n = offset - Math.abs(n);
            n = n * n;
            sum += n * amp * prev;
            maxVal += amp;
            prev = Math.min(n, 1);
            freq *= lacunarity;
            amp *= gain;
        }
        return sum / maxVal;
    }
}
