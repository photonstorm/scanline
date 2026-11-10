// Attaches the probe's own record to a platform object (a context, a texture, a uniform
// location) without the page being able to see it, and without a map lookup on every call.
//
// A class whose constructor returns another object installs its private fields on that
// object. Private fields cannot be listed, read or detected from outside the class, and the
// engine reads them as fast as an ordinary property.
//
// The classes themselves are generated, one per kind of object (tags.generated.ts), because
// classes made by one factory function share their inline caches. A cache that sees
// textures, buffers and programs alike is several times slower than one that sees a single type.

export interface Tag<T>
{
    get: (target: object) => T | undefined;
    set: (target: object, value: T) => void;
}
