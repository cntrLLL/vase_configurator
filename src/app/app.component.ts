import { Component, AfterViewInit, OnDestroy, ViewChild, ElementRef, ChangeDetectionStrategy } from '@angular/core';
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


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gl', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  height = 140;
  topRadius = 70;
  bottomRadius = 35;
  wall = 2.5;
  curvature = 0.35;
  segments = 48;
  roughness = 0.3;
  color = '#c9d2e5';
  rotateY = 0;

  private gl!: WebGL2RenderingContext;
  private raf = 0;
  
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private ebo!: WebGLBuffer;
  private uniformLocations: { [key: string]: WebGLUniformLocation | null } = {};
  private indexCount = 0;
  private indexType!: GLenum;
  private viewMatrix = Mat4.create();
  private projMatrix = Mat4.create();
  private eyePosition = Vec3.create();

  private render = (time: number) => {
    if (!this.gl) return;
    const gl = this.gl;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const modelMatrix = Mat4.fromYRotation(
        (time / 4000) + (this.rotateY * Math.PI / 180)
    );
    const colorVec = this.hexToRgb(this.color);
    const shininess = 8.0 + (1.0 - this.roughness) * (64.0 - 8.0);
    
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniformLocations['uModel'], false, modelMatrix);
    gl.uniformMatrix4fv(this.uniformLocations['uView'], false, this.viewMatrix);
    gl.uniformMatrix4fv(this.uniformLocations['uProj'], false, this.projMatrix);
    gl.uniform3fv(this.uniformLocations['uColor'], colorVec);
    gl.uniform3fv(this.uniformLocations['uViewPos'], this.eyePosition);
    gl.uniform1f(this.uniformLocations['uShininess'], shininess);
    gl.uniform3fv(this.uniformLocations['uLightDir'], Vec3.normalize([0.4, 0.6, 0.7]));

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);

    this.raf = requestAnimationFrame(this.render);
  };

  ngAfterViewInit(): void {
    if (!this.canvasRef) {
      console.error('Canvas element not found!');
      return;
    }
    const canvas = this.canvasRef.nativeElement;
    const gl = canvas.getContext('webgl2', { antialias: true });

    if (!gl) {
      console.error('WebGL2 is not supported by this browser.');
      return;
    }

    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(12 / 255, 16 / 255, 28 / 255, 1.0);
    
    this.initScene();
    this.resize();
    this.render(0);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    if(this.gl) {
      this.gl.deleteBuffer(this.vbo);
      this.gl.deleteBuffer(this.ebo);
      this.gl.deleteVertexArray(this.vao);
      this.gl.deleteProgram(this.program);
    }
  }

  private resize(): void {
    if (!this.gl || !this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    this.gl.viewport(0, 0, canvas.width, canvas.height);

    const h = this.height / 100.0;
    this.eyePosition = [0, 0.1 * h + 0.2, h * 1.5 + 1.0];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    
    this.projMatrix = Mat4.perspective(60 * Math.PI / 180, canvas.width / canvas.height, 0.1, 1000);
    this.viewMatrix = Mat4.lookAt(this.eyePosition, target, up);
  }
  
  private initScene(): void {
    const gl = this.gl;
    
    // --- Shaders ---
    const vsSource = `#version 300 es
      precision highp float;
      uniform mat4 uModel;
      uniform mat4 uView;
      uniform mat4 uProj;
      
      in vec3 aPos;
      in vec3 aNorm;
      
      out vec3 vNormal;
      out vec3 vWorldPos;
      
      void main() {
        vec4 worldPos = uModel * vec4(aPos, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = mat3(uModel) * aNorm;
        gl_Position = uProj * uView * worldPos;
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec3 vNormal;
      in vec3 vWorldPos;
      
      uniform vec3 uColor;
      uniform vec3 uViewPos;
      uniform float uShininess;
      uniform vec3 uLightDir;
      
      out vec4 FragColor;
      
      void main() {
        vec3 ambient = 0.15 * uColor;
        
        vec3 norm = normalize(vNormal);
        vec3 lightDir = normalize(uLightDir);
        float diff = max(dot(norm, lightDir), 0.0);
        vec3 diffuse = diff * uColor;
        
        vec3 viewDir = normalize(uViewPos - vWorldPos);
        vec3 halfwayDir = normalize(lightDir + viewDir);
        float spec = pow(max(dot(norm, halfwayDir), 0.0), uShininess);
        vec3 specular = 0.8 * spec * vec3(1.0);
          
        vec3 result = ambient + diffuse + specular;
        FragColor = vec4(result, 1.0);
      }
    `;

    const program = this.createProgramFromSources(gl, vsSource, fsSource);
    if (!program) return;
    this.program = program;

    this.uniformLocations = {
      uModel: gl.getUniformLocation(program, 'uModel'),
      uView: gl.getUniformLocation(program, 'uView'),
      uProj: gl.getUniformLocation(program, 'uProj'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uViewPos: gl.getUniformLocation(program, 'uViewPos'),
      uShininess: gl.getUniformLocation(program, 'uShininess'),
      uLightDir: gl.getUniformLocation(program, 'uLightDir'),
    };
    const posAttribLoc = gl.getAttribLocation(program, 'aPos');
    const normAttribLoc = gl.getAttribLocation(program, 'aNorm');
    
    // --- Geometry ---
    const mesh = this.generateCupMesh();
    this.indexCount = mesh.indices.length;
    console.log(`Generated mesh with ${this.indexCount} indices.`);

    this.vbo = gl.createBuffer()!;
    this.ebo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    
    gl.bindVertexArray(this.vao);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    
    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(posAttribLoc);
    gl.vertexAttribPointer(posAttribLoc, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(normAttribLoc);
    gl.vertexAttribPointer(normAttribLoc, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
    
    gl.bindVertexArray(null);
  }

  private generateCupMesh() {
    const h = this.height / 100.0;
    const tr = this.topRadius / 100.0;
    const br = this.bottomRadius / 100.0;
    const w = this.wall / 100.0;
    const curv = this.curvature;
    const verticalSegments = this.segments;
    const radialSegments = 64;
    
    const positions: number[] = [];
    const indices: number[] = [];
    
    // Generate profile vertices
    const profile = [];
    for (let s = 0; s <= verticalSegments; s++) {
      const t = s / verticalSegments;
      const z = -h / 2 + t * h;
      const radius = br + (tr - br) * t + curv * (tr - br) * Math.sin(Math.PI * t);
      profile.push({ r: radius, z });
    }

    // Generate vertices for outer and inner surfaces
    for (let s = 0; s <= verticalSegments; s++) {
      for (let r = 0; r < radialSegments; r++) {
        const angle = (r / radialSegments) * 2 * Math.PI;
        const p = profile[s];
        
        // Outer vertex
        positions.push(p.r * Math.cos(angle), p.z, p.r * Math.sin(angle));
        
        // Inner vertex
        const innerRadius = Math.max(p.r - w, 0.01);
        positions.push(innerRadius * Math.cos(angle), p.z, innerRadius * Math.sin(angle));
      }
    }

    // Generate indices
    const verticesPerRing = radialSegments * 2;
    for (let s = 0; s < verticalSegments; s++) {
      for (let r = 0; r < radialSegments; r++) {
        const next_r = (r + 1) % radialSegments;
        
        const i0 = s * verticesPerRing + r * 2;
        const i1 = s * verticesPerRing + next_r * 2;
        const i2 = (s + 1) * verticesPerRing + r * 2;
        const i3 = (s + 1) * verticesPerRing + next_r * 2;
        
        // Outer wall (CCW)
        indices.push(i0, i2, i3, i0, i3, i1);
        
        // Inner wall (CW for correct normals)
        indices.push(i0 + 1, i3 + 1, i2 + 1, i0 + 1, i1 + 1, i3 + 1);
      }
    }
    
    // Bottom cap
    for (let r = 0; r < radialSegments; r++) {
        const next_r = (r + 1) % radialSegments;
        const out0 = r * 2, out1 = next_r * 2;
        const in0 = r * 2 + 1, in1 = next_r * 2 + 1;
        indices.push(out0, in1, in0, out0, out1, in1);
    }
    
    // Calculate Normals
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
      normals[i] = n[0];
      normals[i+1] = n[1];
      normals[i+2] = n[2];
    }
    
    // Interleave data
    const numVertices = positions.length / 3;
    const data = new Float32Array(numVertices * 6);
    for(let i=0; i<numVertices; ++i) {
        data[i*6 + 0] = positions[i*3 + 0];
        data[i*6 + 1] = positions[i*3 + 1];
        data[i*6 + 2] = positions[i*3 + 2];
        data[i*6 + 3] = normals[i*3 + 0];
        data[i*6 + 4] = normals[i*3 + 1];
        data[i*6 + 5] = normals[i*3 + 2];
    }

    const use32BitIndices = numVertices > 65535;
    this.indexType = use32BitIndices ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT;

    return { data, indices: use32BitIndices ? new Uint32Array(indices) : new Uint16Array(indices) };
  }

  private createProgramFromSources(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS compile error:', gl.getShaderInfoLog(vs));
      gl.deleteShader(vs);
      return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS compile error:', gl.getShaderInfoLog(fs));
      gl.deleteShader(fs);
      gl.deleteShader(vs);
      return null;
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    
    gl.deleteShader(vs);
    gl.deleteShader(fs);

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
