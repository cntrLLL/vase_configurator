import { Component, AfterViewInit, OnDestroy, ViewChild, ElementRef, ChangeDetectionStrategy, signal, effect, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

// --- Math Utilities ---

const Vec3 = {
  create: (x = 0, y = 0, z = 0): [number, number, number] => [x, y, z],
  subtract: (a: number[], b: number[]): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a: number[], b: number[]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  normalize: (a: number[]): [number, number, number] => {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (len > 0.00001) {
      return [a[0] / len, a[1] / len, a[2] / len];
    }
    return [0, 0, 0];
  },
  add: (a: number[], b: number[]): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  multiplyByScalar: (a: number[], s: number): [number, number, number] => [a[0] * s, a[1] * s, a[2] * s],
};

const Mat4 = {
  create: (): number[] => [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ],
  multiply: (a: number[], b: number[]): number[] => {
    const out = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          out[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
        }
      }
    }
    return out;
  },
  fromYRotation: (rad: number): number[] => {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    return [
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      0, 0, 0, 1,
    ];
  },
  perspective: (fov: number, aspect: number, near: number, far: number): number[] => {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ];
  },
  lookAt: (eye: number[], center: number[], up: number[]): number[] => {
    const z = Vec3.normalize(Vec3.subtract(eye, center));
    const x = Vec3.normalize(Vec3.cross(up, z));
    const y = Vec3.normalize(Vec3.cross(z, x));
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ];
  },
};

type Tab = 'material' | 'glaze' | 'shape' | 'finish' | 'mark';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gl', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  
  // UI State
  activeTab = signal<Tab>('material');

  // Shape
  height = signal(140);
  topRadius = signal(70);
  bottomRadius = signal(35);
  wall = signal(2.5);
  curvature = signal(0.35);
  rimProfile = signal('standard');

  // Material
  material = signal<'ceramic' | 'glass' | 'metal'>('ceramic');
  
  // Glaze
  glazeType = signal<'solid' | 'swirl'>('swirl');
  glazeColor1 = signal('#f3f4f6');
  glazeColor2 = signal('#3b82f6');
  glazeDetail = signal(4.0);
  glazeComplexity = signal(2.0);
  glazeSeed = signal(Math.random() * 100);

  // Finish
  finishRoughness = signal(0.4);
  finishMetalness = signal(0.0);
  finishClearcoat = signal(0.1);
  edgeTrim = signal(false);

  // Mark
  underfootCode = signal('A-01');
  markSize = signal(0.5);

  // Camera
  cameraAzimuth = signal(0.5);
  cameraElevation = signal(0.4);
  cameraDistance = signal(0.8); // Multiplier

  private isGlInitialized = signal(false);

  private gl!: WebGL2RenderingContext;
  private raf = 0;
  
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private ebo!: WebGLBuffer;
  private markTexture!: WebGLTexture;
  private uniformLocations: { [key: string]: WebGLUniformLocation | null } = {};
  
  private indexCount = 0;
  private indexType!: GLenum;
  private viewMatrix = Mat4.create();
  private projMatrix = Mat4.create();
  private eyePosition: [number, number, number] = [0, 0, 0];
  
  private segments = 64; // Fixed high quality

  // Mouse drag state
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  constructor() {
    // Effect for geometry updates
    effect(() => {
      if (!this.isGlInitialized()) return;
      this.height();
      this.topRadius();
      this.bottomRadius();
      this.wall();
      this.curvature();
      this.rimProfile();
      untracked(() => this.updateGeometry());
    });

    // Effect for mark texture update
    effect(() => {
      if (!this.isGlInitialized()) return;
      this.underfootCode();
      untracked(() => this.updateMarkTexture());
    });

    // Effect for camera updates
    effect(() => {
      if (!this.isGlInitialized()) return;
      
      const distanceMultiplier = this.cameraDistance();
      const azimuth = this.cameraAzimuth();
      const elevation = this.cameraElevation();

      const h = untracked(this.height) / 100.0;
      const baseDistance = h * 1.5 + 1.5;
      const finalDistance = baseDistance * distanceMultiplier;

      const x = finalDistance * Math.cos(elevation) * Math.sin(azimuth);
      const y = finalDistance * Math.sin(elevation);
      const z = finalDistance * Math.cos(elevation) * Math.cos(azimuth);

      this.eyePosition = [x, y, z];
      const target: [number, number, number] = [0, 0, 0];
      const up: [number, number, number] = [0, 1, 0];
      
      this.viewMatrix = Mat4.lookAt(this.eyePosition, target, up);
    });
  }

  resetToDefaults(): void {
    this.activeTab.set('material');
    this.height.set(140);
    this.topRadius.set(70);
    this.bottomRadius.set(35);
    this.wall.set(2.5);
    this.curvature.set(0.35);
    this.rimProfile.set('standard');
    this.material.set('ceramic');
    this.glazeType.set('swirl');
    this.glazeColor1.set('#f3f4f6');
    this.glazeColor2.set('#3b82f6');
    this.glazeDetail.set(4.0);
    this.glazeComplexity.set(2.0);
    this.regenerateGlaze();
    this.finishRoughness.set(0.4);
    this.finishMetalness.set(0.0);
    this.finishClearcoat.set(0.1);
    this.underfootCode.set('A-01');
    this.markSize.set(0.5);
    this.cameraAzimuth.set(0.5);
    this.cameraElevation.set(0.4);
    this.cameraDistance.set(0.8);
  }
  
  regenerateGlaze(): void {
    this.glazeSeed.set(Math.random() * 100);
  }

  private render = (time: number) => {
    if (!this.gl) return;
    const gl = this.gl;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    const modelMatrix = Mat4.create(); // Use identity matrix, camera is controlled now
    
    let metallic = this.finishMetalness();
    let roughness = this.finishRoughness();
    let alpha = 1.0;
    
    switch(this.material()) {
        case 'glass':
            metallic = 0.05;
            roughness = Math.min(roughness, 0.2);
            alpha = 0.2;
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            break;
        case 'metal':
            metallic = 1.0;
            gl.disable(gl.BLEND);
            break;
        case 'ceramic':
        default:
            gl.disable(gl.BLEND);
            break;
    }
    
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniformLocations['uModel'], false, modelMatrix);
    gl.uniformMatrix4fv(this.uniformLocations['uView'], false, this.viewMatrix);
    gl.uniformMatrix4fv(this.uniformLocations['uProj'], false, this.projMatrix);
    gl.uniform3fv(this.uniformLocations['uViewPos'], this.eyePosition);
    gl.uniform1f(this.uniformLocations['uAlpha'], alpha);
    
    // PBR-like uniforms from Finish tab
    gl.uniform1f(this.uniformLocations['uRoughness'], roughness);
    gl.uniform1f(this.uniformLocations['uMetalness'], metallic);
    gl.uniform1f(this.uniformLocations['uClearcoat'], this.finishClearcoat());

    // Glaze Uniforms
    gl.uniform1i(this.uniformLocations['uGlazeType'], this.glazeType() === 'swirl' ? 1 : 0);
    gl.uniform3fv(this.uniformLocations['uGlazeColor1'], this.hexToRgb(this.glazeColor1()));
    gl.uniform3fv(this.uniformLocations['uGlazeColor2'], this.hexToRgb(this.glazeColor2()));
    gl.uniform1f(this.uniformLocations['uGlazeDetail'], this.glazeDetail());
    gl.uniform1f(this.uniformLocations['uGlazeComplexity'], this.glazeComplexity());
    gl.uniform1f(this.uniformLocations['uGlazeSeed'], this.glazeSeed());

    // Mark Uniforms
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.markTexture);
    gl.uniform1i(this.uniformLocations['uMarkTexture'], 0);
    gl.uniform1f(this.uniformLocations['uMarkSize'], this.markSize());

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);

    this.raf = requestAnimationFrame(this.render);
  };

  ngAfterViewInit(): void {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!gl) return;

    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(241/255, 245/255, 249/255, 1.0);
    
    this.initScene();
    this.isGlInitialized.set(true); 
    this.render(0);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    if(this.gl) {
      this.gl.deleteBuffer(this.vbo);
      this.gl.deleteBuffer(this.ebo);
      this.gl.deleteVertexArray(this.vao);
      this.gl.deleteProgram(this.program);
      this.gl.deleteTexture(this.markTexture);
    }
  }

  // --- Mouse Event Handlers ---
  onMouseDown(event: MouseEvent): void {
    this.isDragging = true;
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
    this.canvasRef.nativeElement.style.cursor = 'grabbing';
  }

  onMouseMove(event: MouseEvent): void {
    if (!this.isDragging) return;
    const dx = event.clientX - this.lastMouseX;
    const dy = event.clientY - this.lastMouseY;

    this.cameraAzimuth.update(a => a - dx * 0.005);
    this.cameraElevation.update(e => {
        const newE = e - dy * 0.005;
        // Clamp elevation to prevent flipping over
        return Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, newE));
    });

    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
  }

  onMouseUp(): void {
    this.isDragging = false;
    this.canvasRef.nativeElement.style.cursor = 'grab';
  }

  onMouseLeave(): void {
    if (this.isDragging) {
        this.isDragging = false;
        this.canvasRef.nativeElement.style.cursor = 'grab';
    }
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const zoomAmount = event.deltaY * 0.002;
    this.cameraDistance.update(d => {
        // Clamp distance multiplier
        return Math.max(0.5, Math.min(3.0, d + zoomAmount));
    });
  }


  private updateMarkTexture(): void {
    if (!this.gl) return;
    const gl = this.gl;

    const text = this.underfootCode();
    const canvas = document.createElement('canvas');
    const size = 128;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, size, size);
    
    ctx.fillStyle = '#475569'; // slate-600
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(text, size / 2, size / 2);

    gl.bindTexture(gl.TEXTURE_2D, this.markTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private updateGeometry(): void {
    if (!this.gl) return;
    const gl = this.gl;

    const mesh = this.generateVaseMesh();
    this.indexCount = mesh.indices.length;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    this.resize();
  }

  private resize(): void {
    if (!this.gl || !this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    
    const displayWidth  = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    if (canvas.width  !== displayWidth || canvas.height !== displayHeight) {
      canvas.width  = displayWidth;
      canvas.height = displayHeight;
    }

    this.gl.viewport(0, 0, canvas.width, canvas.height);
    this.projMatrix = Mat4.perspective(45 * Math.PI / 180, canvas.width / canvas.height, 0.1, 1000);
  }
  
  private initScene(): void {
    const gl = this.gl;
    
    const vsSource = `#version 300 es
      precision highp float;
      uniform mat4 uModel;
      uniform mat4 uView;
      uniform mat4 uProj;
      
      in vec3 aPos;
      in vec3 aNorm;
      in vec2 aTexCoord;

      out vec3 vNormal;
      out vec3 vWorldPos;
      out vec2 vTexCoord;
      
      void main() {
        vec4 worldPos = uModel * vec4(aPos, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = mat3(transpose(inverse(uModel))) * aNorm;
        vTexCoord = aTexCoord;
        gl_Position = uProj * uView * worldPos;
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec3 vNormal;
      in vec3 vWorldPos;
      in vec2 vTexCoord;
      
      uniform vec3 uViewPos;
      uniform float uAlpha;

      // PBR Finish
      uniform float uRoughness;
      uniform float uMetalness;
      uniform float uClearcoat;

      // Glaze
      uniform int uGlazeType;
      uniform vec3 uGlazeColor1;
      uniform vec3 uGlazeColor2;
      uniform float uGlazeDetail;
      uniform float uGlazeComplexity;
      uniform float uGlazeSeed;

      // Mark
      uniform sampler2D uMarkTexture;
      uniform float uMarkSize;

      out vec4 FragColor;
      
      const float PI = 3.14159265359;
      const vec3 lightPositions[2] = vec3[](
        vec3(5.0, 5.0, 5.0),
        vec3(-5.0, 3.0, -2.0)
      );
      const vec3 lightColors[2] = vec3[](
        vec3(1.0, 1.0, 0.95) * 1.5,
        vec3(0.95, 1.0, 1.0) * 0.5
      );

      // --- Simplex Noise GLSL ---
      vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
      vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
      float snoise(vec3 v) {
        const vec2 C = vec2(1.0/6.0, 1.0/3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        i = mod289(i);
        vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);
        vec4 x = x_ * ns.x + ns.yyyy;
        vec4 y = y_ * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);
        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);
        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
        vec3 p0 = vec3(a0.xy,h.x);
        vec3 p1 = vec3(a0.zw,h.y);
        vec3 p2 = vec3(a1.xy,h.z);
        vec3 p3 = vec3(a1.zw,h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
      }

      // PBR Functions
      float DistributionGGX(vec3 N, vec3 H, float roughness) {
          float a = roughness*roughness;
          float a2 = a*a;
          float NdotH = max(dot(N, H), 0.0);
          float NdotH2 = NdotH*NdotH;
          float nom   = a2;
          float denom = (NdotH2 * (a2 - 1.0) + 1.0);
          denom = PI * denom * denom;
          return nom / denom;
      }
      float GeometrySchlickGGX(float NdotV, float roughness) {
          float r = (roughness + 1.0);
          float k = (r*r) / 8.0;
          float nom   = NdotV;
          float denom = NdotV * (1.0 - k) + k;
          return nom / denom;
      }
      float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
          float NdotV = max(dot(N, V), 0.0);
          float NdotL = max(dot(N, L), 0.0);
          float ggx2 = GeometrySchlickGGX(NdotV, roughness);
          float ggx1 = GeometrySchlickGGX(NdotL, roughness);
          return ggx1 * ggx2;
      }
      vec3 fresnelSchlick(float cosTheta, vec3 F0) {
          return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
      }

      void main() {
        // --- Base Color from Glaze ---
        vec3 albedo;
        if (uGlazeType == 1) { // Swirl
            vec3 p = vWorldPos * uGlazeDetail + vec3(uGlazeSeed);
            float f = 0.0; float amp = 0.5;
            mat3 m = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
            for(int i=0; i<3; i++) {
                f += amp * snoise(p);
                p = m * p * uGlazeComplexity;
                amp *= 0.5;
            }
            float t = smoothstep(0.3, 0.7, (f + 1.0) * 0.5);
            albedo = mix(uGlazeColor1, uGlazeColor2, t);
        } else { // Solid
            albedo = uGlazeColor1;
        }

        // --- Apply Underfoot Mark ---
        if (vTexCoord.x >= 0.0) {
            vec2 markUV = (vTexCoord - 0.5) / uMarkSize + 0.5;
            if(markUV.x >= 0.0 && markUV.x <= 1.0 && markUV.y >= 0.0 && markUV.y <= 1.0) {
              vec4 markColor = texture(uMarkTexture, markUV);
              albedo = mix(albedo, markColor.rgb, markColor.a);
            }
        }

        // --- PBR Calculation ---
        vec3 N = normalize(vNormal);
        vec3 V = normalize(uViewPos - vWorldPos);
        vec3 F0 = vec3(0.04); 
        F0 = mix(F0, albedo, uMetalness);
        vec3 Lo = vec3(0.0);
        for(int i = 0; i < 2; ++i) {
            vec3 L = normalize(lightPositions[i] - vWorldPos);
            vec3 H = normalize(V + L);
            float NDF = DistributionGGX(N, H, uRoughness);
            float G = GeometrySmith(N, V, L, uRoughness);
            vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
            vec3 nominator = NDF * G * F;
            float denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
            vec3 specular = nominator / denominator;
            vec3 kD = vec3(1.0) - F;
            kD *= 1.0 - uMetalness;
            float NdotL = max(dot(N, L), 0.0);
            Lo += (kD * albedo / PI + specular) * lightColors[i] * NdotL;
        }

        // --- Clearcoat Layer ---
        float clearcoatRoughness = 0.1;
        float F_clearcoat = 0.04; // Standard dielectric
        vec3 clearcoat = vec3(0.0);
        if(uClearcoat > 0.0) {
          for(int i = 0; i < 2; ++i) {
              vec3 L = normalize(lightPositions[i] - vWorldPos);
              vec3 H = normalize(V + L);
              float NDF_c = DistributionGGX(N, H, clearcoatRoughness);
              float G_c = GeometrySmith(N, V, L, clearcoatRoughness);
              float F_c = F_clearcoat + (1.0 - F_clearcoat) * pow(clamp(1.0 - max(dot(H, V), 0.0), 0.0, 1.0), 5.0);
              float spec_c = (NDF_c * G_c * F_c) / (4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001);
              clearcoat += spec_c * lightColors[i] * max(dot(N, L), 0.0);
          }
        }
        
        vec3 ambient = vec3(0.03) * albedo;
        vec3 color = ambient + Lo;
        color = mix(color, color + clearcoat, uClearcoat);

        FragColor = vec4(color, uAlpha);
      }
    `;

    const program = this.createProgramFromSources(gl, vsSource, fsSource);
    if (!program) return;
    this.program = program;

    this.uniformLocations = {
      uModel: gl.getUniformLocation(program, 'uModel'),
      uView: gl.getUniformLocation(program, 'uView'),
      uProj: gl.getUniformLocation(program, 'uProj'),
      uViewPos: gl.getUniformLocation(program, 'uViewPos'),
      uAlpha: gl.getUniformLocation(program, 'uAlpha'),
      uRoughness: gl.getUniformLocation(program, 'uRoughness'),
      uMetalness: gl.getUniformLocation(program, 'uMetalness'),
      uClearcoat: gl.getUniformLocation(program, 'uClearcoat'),
      uGlazeType: gl.getUniformLocation(program, 'uGlazeType'),
      uGlazeColor1: gl.getUniformLocation(program, 'uGlazeColor1'),
      uGlazeColor2: gl.getUniformLocation(program, 'uGlazeColor2'),
      uGlazeDetail: gl.getUniformLocation(program, 'uGlazeDetail'),
      uGlazeComplexity: gl.getUniformLocation(program, 'uGlazeComplexity'),
      uGlazeSeed: gl.getUniformLocation(program, 'uGlazeSeed'),
      uMarkTexture: gl.getUniformLocation(program, 'uMarkTexture'),
      uMarkSize: gl.getUniformLocation(program, 'uMarkSize'),
    };
    const posAttribLoc = gl.getAttribLocation(program, 'aPos');
    const normAttribLoc = gl.getAttribLocation(program, 'aNorm');
    const texAttribLoc = gl.getAttribLocation(program, 'aTexCoord');
    
    this.vbo = gl.createBuffer()!;
    this.ebo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    
    const stride = 8 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(posAttribLoc);
    gl.vertexAttribPointer(posAttribLoc, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(normAttribLoc);
    gl.vertexAttribPointer(normAttribLoc, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(texAttribLoc);
    gl.vertexAttribPointer(texAttribLoc, 2, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
    gl.bindVertexArray(null);

    this.markTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.markTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  private generateVaseMesh() {
    const h = this.height() / 100.0;
    const tr = this.topRadius() / 100.0;
    const br = this.bottomRadius() / 100.0;
    const w = this.wall() / 100.0;
    const curv = this.curvature();
    const verticalSegments = this.segments;
    const radialSegments = this.segments * 2;
    
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    
    const profile: { r: number; z: number }[] = [];
    for (let s = 0; s <= verticalSegments; s++) {
      const t = s / verticalSegments;
      const z = -h / 2 + t * h;
      const radius = br + (tr - br) * t + curv * (tr - br) * Math.sin(Math.PI * t);
      profile.push({ r: radius, z });
    }

    for (let s = 0; s <= verticalSegments; s++) {
      for (let r = 0; r < radialSegments; r++) {
        const angle = (r / radialSegments) * 2 * Math.PI;
        const p = profile[s];
        positions.push(p.r * Math.cos(angle), p.z, p.r * Math.sin(angle));
        const innerRadius = Math.max(p.r - w, 0.01);
        positions.push(innerRadius * Math.cos(angle), p.z, innerRadius * Math.sin(angle));
        uvs.push(-1, -1); uvs.push(-1, -1);
      }
    }

    const verticesPerRing = radialSegments * 2;
    for (let s = 0; s < verticalSegments; s++) {
      for (let r = 0; r < radialSegments; r++) {
        const next_r = (r + 1) % radialSegments;
        const i0 = s * verticesPerRing + r * 2;
        const i1 = s * verticesPerRing + next_r * 2;
        const i2 = (s + 1) * verticesPerRing + r * 2;
        const i3 = (s + 1) * verticesPerRing + next_r * 2;
        indices.push(i0, i2, i3, i0, i3, i1);
        indices.push(i0 + 1, i3 + 1, i2 + 1, i0 + 1, i1 + 1, i3 + 1);
      }
    }
    
    for (let r = 0; r < radialSegments; r++) {
        const next_r = (r + 1) % radialSegments;
        const s = verticalSegments;
        const out0 = s * verticesPerRing + r * 2;
        const out1 = s * verticesPerRing + next_r * 2;
        const in0 = s * verticesPerRing + r * 2 + 1;
        const in1 = s * verticesPerRing + next_r * 2 + 1;
        indices.push(out0, out1, in1, out0, in1, in0);
    }

    const bottomCenterIndex = positions.length / 3;
    positions.push(0, profile[0].z, 0); 
    uvs.push(0.5, 0.5); // UV for center of bottom
    for (let r = 0; r < radialSegments; r++) {
      const i0 = r * 2; // Outer vertex at bottom ring
      
      // Set UV for this vertex, for the underfoot mark
      const angle = (r / radialSegments) * 2 * Math.PI;
      const u = 0.5 - Math.cos(angle) * 0.5; // Flip u-coord to prevent mirrored text
      const v = 0.5 + Math.sin(angle) * 0.5;
      uvs[i0 * 2] = u;
      uvs[i0 * 2 + 1] = v;
      
      // Create triangle for the bottom surface fan
      const next_r = (r + 1) % radialSegments;
      const i1 = next_r * 2;
      indices.push(i0, bottomCenterIndex, i1); // Note winding for downward normal
    }
    
    const normals: number[] = new Array(positions.length).fill(0);
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i+1], i2 = indices[i+2];
      const p0 = positions.slice(i0*3, i0*3+3);
      const p1 = positions.slice(i1*3, i1*3+3);
      const p2 = positions.slice(i2*3, i2*3+3);
      const v1 = Vec3.subtract(p1, p0);
      const v2 = Vec3.subtract(p2, p0);
      const normal = Vec3.cross(v1, v2);
      for(let j=0; j<3; ++j) {
        normals[i0*3+j] += normal[j];
        normals[i1*3+j] += normal[j];
        normals[i2*3+j] += normal[j];
      }
    }
    for(let i=0; i < normals.length; i+=3) {
      const n = Vec3.normalize(normals.slice(i, i+3));
      normals[i] = n[0]; normals[i+1] = n[1]; normals[i+2] = n[2];
    }
    
    const numVertices = positions.length / 3;
    const data = new Float32Array(numVertices * 8);
    for(let i=0; i<numVertices; ++i) {
        data[i*8 + 0] = positions[i*3 + 0]; data[i*8 + 1] = positions[i*3 + 1]; data[i*8 + 2] = positions[i*3 + 2];
        data[i*8 + 3] = normals[i*3 + 0]; data[i*8 + 4] = normals[i*3 + 1]; data[i*8 + 5] = normals[i*3 + 2];
        data[i*8 + 6] = uvs[i*2 + 0]; data[i*8 + 7] = uvs[i*2 + 1];
    }

    const use32BitIndices = numVertices > 65535;
    this.indexType = use32BitIndices ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT;
    return { data, indices: use32BitIndices ? new Uint32Array(indices) : new Uint16Array(indices) };
  }

  private createProgramFromSources(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS compile error:', gl.getShaderInfoLog(vs)); gl.deleteShader(vs); return null;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS compile error:', gl.getShaderInfoLog(fs)); gl.deleteShader(fs); gl.deleteShader(vs); return null;
    }
    const program = gl.createProgram()!;
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program)); gl.deleteProgram(program); return null;
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return program;
  }
  
  private hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255,
    ] : [1, 1, 1];
  }
}